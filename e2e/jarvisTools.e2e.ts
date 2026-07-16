import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { mainCall, seed } from './helpers'

/**
 * Jarvis J4 — HANDS: a voice-driven tool call behind the turn-act confirm gate, end to
 * end and deterministic (PLAN §5 J4 gate). The stub voice engine speaks a scripted
 * "add a card …" final; the CANVAS_LLM_MOCK brain assembles a REAL add_card tool call;
 * the REAL executor validates + resolves it; the REAL kanban gate raises its human
 * confirm, which the MAIN-side origin stamp routes to the PANEL act-card (never the
 * center modal); ✓ / a spoken "yes" approves — the card lands on the real board — and
 * the spoken confirmation quotes the tool result. Deny changes nothing. Zero egress.
 */

interface JarvisProbe {
  converseMode: boolean
  panelOpen: boolean
  lastAssistantText: string
  lastError: string | null
  acts: Array<{ actId: number; name: string; phase: string; summary: string }>
  pendingConfirm: { title: string; body: string } | null
  actChipCount: number
}

const jarvisState = (page: Page): Promise<JarvisProbe> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.jarvisState())

/** The seeded kanban's card titles, straight from the store document (top-level `cards`). */
const cardTitles = (page: Page, boardId: string): Promise<string[]> =>
  page.evaluate((id) => {
    const doc = JSON.parse((globalThis as any).__canvasE2E.serializeDoc())
    const board = (doc.boards as any[]).find((b) => b.id === id)
    return ((board?.cards ?? []) as any[]).map((c) => c.title)
  }, boardId)

/** Stub script speaking `final` (with a lead-in partial so the pipeline stays realistic). */
const script = (
  final: string,
  extra: Array<{ atFrame: number; t: 'partial' | 'final'; text: string }> = []
): Array<{ atFrame: number; t: 'partial' | 'final'; text: string }> => [
  { atFrame: 2, t: 'partial', text: final.slice(0, 10) },
  { atFrame: 10, t: 'final', text: final },
  ...extra
]

async function openPanel(page: Page): Promise<void> {
  await page.locator('[data-test="jarvis-edge-tab"]').click()
  await expect
    .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
    .toBe(true)
}

test.describe('@voice jarvis hands (voice → tool call → confirm gate → canvas)', () => {
  test.beforeEach(async ({ electronApp }) => {
    await mainCall(electronApp, 'setLlmMock', true)
  })
  test.afterEach(async ({ page, electronApp }) => {
    await page.evaluate(() => (globalThis as any).api.voice.stop()).catch(() => {})
    await mainCall(electronApp, 'setLlmMock', false)
    await mainCall(electronApp, 'voiceStubSet', false)
  })

  test('add_card pauses on the panel act-card; ✓ lands the card; the reply quotes the result', async ({
    page,
    electronApp
  }) => {
    const boardId = await seed(page, 'kanban', {})
    const id8 = boardId.slice(0, 8)
    await mainCall(
      electronApp,
      'voiceStubSet',
      true,
      script(`add a card smoke test to board ${id8}`)
    )

    await openPanel(page)

    // The gate parks: pending act-card in the panel, NO center modal, and the canvas is
    // untouched while it waits (nothing executes before the human).
    await expect
      .poll(async () => (await jarvisState(page)).pendingConfirm !== null, { timeout: 15_000 })
      .toBe(true)
    const card = page.locator('[data-test="jarvis-act-card"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText('add_card')
    expect(await page.locator('[data-testid="confirm-modal"]').count()).toBe(0)
    expect(await cardTitles(page, boardId)).not.toContain('smoke test')

    // ✓ one tap → the REAL kanban write lands on the REAL board.
    await page.locator('[data-test="jarvis-act-approve"]').click()
    await expect
      .poll(async () => cardTitles(page, boardId), { timeout: 15_000 })
      .toContain('smoke test')

    // The resolved chip + the GROUNDED spoken confirmation (quotes the tool result JSON,
    // which carries the minted card id — never an invented status). The active-turn acts
    // FOLD into the transcript the moment the turn settles (turnDone clears `acts`), so
    // accept either home — the live 'ok' row or the folded chip.
    await expect
      .poll(
        async () => {
          const s = await jarvisState(page)
          return s.acts.some((a) => a.phase === 'ok') || s.actChipCount >= 1
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain('Done. The tool reported')
    const s = await jarvisState(page)
    expect(s.lastError).toBeNull()
    expect(s.actChipCount).toBeGreaterThanOrEqual(1) // the chip survived into the transcript
    expect(s.pendingConfirm).toBeNull()
  })

  test('✗ deny changes NOTHING and the reply says so', async ({ page, electronApp }) => {
    const boardId = await seed(page, 'kanban', {})
    await mainCall(
      electronApp,
      'voiceStubSet',
      true,
      script(`add a card never land to board ${boardId.slice(0, 8)}`)
    )
    await openPanel(page)
    await expect
      .poll(async () => (await jarvisState(page)).pendingConfirm !== null, { timeout: 15_000 })
      .toBe(true)
    await page.locator('[data-test="jarvis-act-deny"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain('Nothing was changed')
    expect(await cardTitles(page, boardId)).not.toContain('never land')
    const denied = (await jarvisState(page)).acts.concat()
    // The denied chip may already have folded into the transcript — accept either home.
    const st = await jarvisState(page)
    expect(denied.some((a) => a.phase === 'denied') || st.actChipCount >= 1).toBe(true)
  })

  test('a spoken "yes" answers the SAME pending act (confirm bound to the parked gate)', async ({
    page,
    electronApp
  }) => {
    const boardId = await seed(page, 'kanban', {})
    const id8 = boardId.slice(0, 8)
    // One script: the command final, then — while the act-card is parked — a "yes" final
    // (~frame 60 ≈ 7 s in; the gate is pending well before it, and it blocks until answered).
    await mainCall(
      electronApp,
      'voiceStubSet',
      true,
      script(`add a card voice approved to board ${id8}`, [
        { atFrame: 60, t: 'final', text: 'yes' }
      ])
    )
    await openPanel(page)
    await expect
      .poll(async () => (await jarvisState(page)).pendingConfirm !== null, { timeout: 15_000 })
      .toBe(true)
    // No click — the scripted "yes" resolves the parked confirm.
    await expect
      .poll(async () => cardTitles(page, boardId), { timeout: 20_000 })
      .toContain('voice approved')
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain('Done. The tool reported')
  })

  test('read-tier focus_viewport runs with NO gate (auto-allow)', async ({ page, electronApp }) => {
    const boardId = await seed(page, 'terminal', {})
    await mainCall(electronApp, 'voiceStubSet', true, script(`focus board ${boardId.slice(0, 8)}`))
    await openPanel(page)
    await expect
      .poll(
        async () => {
          const s = await jarvisState(page)
          return (
            s.acts.some((a) => a.name === 'focus_viewport' && a.phase === 'ok') ||
            s.actChipCount >= 1
          )
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    // Never gated: no act-card, no modal, no parked confirm along the way.
    expect(await page.locator('[data-test="jarvis-act-approve"]').count()).toBe(0)
    expect(await page.locator('[data-testid="confirm-modal"]').count()).toBe(0)
    expect((await jarvisState(page)).pendingConfirm).toBeNull()
  })
})

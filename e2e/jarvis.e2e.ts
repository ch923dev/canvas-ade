import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { mainCall } from './helpers'

/**
 * Jarvis J3 — converse round-trip (docs/research/2026-07-04-jarvis-voice-agent,
 * KICKOFF-J3 §3). Deterministic end to end: the STUB voice engine supplies the final
 * transcript over the real session MessagePort, `setLlmMock` flips CANVAS_LLM_MOCK so the
 * brain streams the deterministic mock reply with zero egress, and TTS degrades to
 * text-only (no model on CI) — proving the full renderer↔MAIN turn pipeline: island click
 * → converse mode → final consumed (NOT the dictation draft) → jarvis:turn:start → delta
 * stream → tail text → done → display transcript + conversation view.
 */

const STUB_FINAL = 'refactor the preview cap' // VOICE_STUB_SCRIPT's final text
const MOCK_REPLY_HEAD = `Understood: ${STUB_FINAL}` // mockJarvisReply's deterministic head

interface JarvisProbe {
  converseMode: boolean
  activeTurnId: number | null
  awaitingReply: boolean
  streamText: string
  lastUserText: string
  turnCount: number
  lastAssistantText: string
  tailOpen: boolean
  viewOpen: boolean
  lastError: string | null
}

const jarvisState = (page: Page): Promise<JarvisProbe> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.jarvisState())

const voiceDraft = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.voiceState().draft)

test.describe('@voice jarvis converse (stub voice → mock brain → tail + transcript)', () => {
  test.beforeEach(async ({ electronApp }) => {
    await mainCall(electronApp, 'voiceStubSet', true)
    await mainCall(electronApp, 'setLlmMock', true)
  })
  test.afterEach(async ({ page, electronApp }) => {
    // End any live capture so no session/consumer leaks into the next spec (resetAll
    // also force-disarms converse mode renderer-side).
    await page.evaluate(() => (globalThis as any).api.voice.stop()).catch(() => {})
    await mainCall(electronApp, 'setLlmMock', false)
    await mainCall(electronApp, 'voiceStubSet', false)
  })

  test('island click → converse turn → mock reply streams into the tail, dictation stays untouched', async ({
    page
  }) => {
    const island = page.locator('[data-test="jarvis-island"]')
    await expect(island).toBeVisible()

    // Arm converse mode (a clean click — the drag threshold must not eat it).
    await island.click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)

    // The stub final routes to the brain: the tail opens with the utterance + the mock
    // reply streams to done. The dictation flyout/draft must never see the final.
    await expect
      .poll(async () => (await jarvisState(page)).lastUserText, { timeout: 15_000 })
      .toBe(STUB_FINAL)
    await expect(page.locator('[data-test="jarvis-tail"]')).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain(MOCK_REPLY_HEAD)
    const done = await jarvisState(page)
    expect(done.turnCount).toBeGreaterThanOrEqual(2) // user + assistant landed
    expect(done.lastError).toBeNull()
    expect(await voiceDraft(page)).toBe('') // converse consumed the final — no draft leak
    await expect(page.locator('.voice-flyout')).toHaveCount(0) // composer suppressed

    // The rendered tail carries the reply text (not just the store).
    await expect(
      page.locator('[data-test="jarvis-reply"], [data-test="jarvis-history"]').first()
    ).toContainText('Understood', { timeout: 5_000 })

    // D4′ conversation view: expand → the session transcript renders both rows.
    await page.locator('[data-test="jarvis-expand"]').click()
    await expect.poll(async () => (await jarvisState(page)).viewOpen).toBe(true)
    await expect(page.locator('[data-test="jarvis-history"]')).toContainText(STUB_FINAL)
    await expect(page.locator('[data-test="jarvis-history"]')).toContainText('Understood')

    // Esc collapses the view first, then dismisses the tail.
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).viewOpen).toBe(false)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).tailOpen).toBe(false)

    // Ending the conversation: click the island again.
    await island.click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(false)
  })

  test('MAIN history follows the mode: recorded per project, cleared on demand', async ({
    page
  }) => {
    const island = page.locator('[data-test="jarvis-island"]')
    await island.click()
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain(MOCK_REPLY_HEAD)
    // MAIN's canonical history recorded the exchange (the D4′ session mode default).
    const history = await page.evaluate(() => (globalThis as any).api.jarvis.history.get())
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[0].text).toBe(STUB_FINAL)
    // Clear (the Settings › Persona Clear button's IPC) empties it.
    await page.evaluate(() => (globalThis as any).api.jarvis.history.clear())
    expect(await page.evaluate(() => (globalThis as any).api.jarvis.history.get())).toEqual([])
    await island.click() // end converse
  })
})

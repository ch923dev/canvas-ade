import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Voice V3 — pill + flyout + terminal injection (docs/research/2026-07-02-voice-to-text,
 * plan §V3). Runs against the STUB engine (voiceEngineStub.ts) toggled per-test through
 * `__canvasE2EMain.voiceStubSet` — deterministic canned partial/final over the REAL
 * session MessagePort, no model, no mic (fake media supplies getUserMedia). voice.e2e.ts
 * keeps exercising the real utilityProcess host; the stub is always flipped back off.
 *
 * The load-bearing byte assertion: Send = paste text (bracketed, multi-line safe) then
 * ONE discrete `\r` as its OWN PTY write; Insert = paste only. Proven via the
 * e2eTerminalInput chunk log (`readTerminalInputChunks`).
 */

const READY = 'VOICE_E2E_READY'
const STUB_FINAL = 'refactor the preview cap' // VOICE_STUB_SCRIPT's final text

const voiceState = (
  page: Page
): Promise<{
  capturing: boolean
  draft: string
  partial: string
  flyoutOpen: boolean
  framesSent: number
}> => page.evaluate(() => (globalThis as any).__canvasE2E.voiceState())

const chunks = (page: Page, id: string): Promise<string[]> =>
  evalIn<string[]>(page, `window.__canvasE2E.readTerminalInputChunks(${JSON.stringify(id)})`)

/** Seed a terminal, wait for its shell to be live, select it as the dictation target. */
async function seedTarget(page: Page): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: `echo ${READY}` })
  const ok = await pollEval(
    page,
    `(() => { const t = window.__canvasE2E.readTerminal(${JSON.stringify(id)}); return typeof t === 'string' && t.includes(${JSON.stringify(READY)}); })()`,
    15_000
  )
  expect(ok, 'terminal shell live').toBe(true)
  await evalIn(page, `window.__canvasE2E.setSelection([${JSON.stringify(id)}])`)
  return id
}

/** Dictate through the stub until the canned final lands in the draft, then stop. */
async function dictateFinal(page: Page): Promise<void> {
  await page.locator('.voice-pill').click()
  await expect.poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 }).toBe(true)
  // Stub partials arrive at frames 2/5 (~250/600 ms) — the flyout opens on the first one.
  await expect(page.locator('.voice-flyout')).toBeVisible({ timeout: 10_000 })
  // The final (frame 9) folds the tail into the editable draft.
  await expect
    .poll(async () => (await voiceState(page)).draft, { timeout: 10_000 })
    .toBe(STUB_FINAL)
  await page.locator('.voice-pill').click() // reviewing: mic off, flyout stays
  await expect.poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 }).toBe(false)
}

test.describe('@terminal @voice voice composer (stub engine → pill/flyout/injection)', () => {
  test.beforeEach(async ({ electronApp }) => {
    await mainCall(electronApp, 'voiceStubSet', true)
  })
  test.afterEach(async ({ page, electronApp }) => {
    await page.evaluate(() => (globalThis as any).api.voice.stop()).catch(() => {})
    await mainCall(electronApp, 'voiceStubSet', false)
  })

  test('dictate → partial tail → final → edit → Send lands exact bytes + ONE discrete \\r', async ({
    page
  }) => {
    const id = await seedTarget(page)
    await expect(page.locator('.voice-pill')).toBeVisible()

    await page.locator('.voice-pill').click()
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(true)
    // listening: the dimmed-italic tail renders in the flyout mirror before any final.
    await expect(page.locator('[data-test="voice-flyout-partial"]')).toBeVisible({
      timeout: 10_000
    })
    await expect
      .poll(async () => (await voiceState(page)).draft, { timeout: 10_000 })
      .toBe(STUB_FINAL)
    expect((await voiceState(page)).partial).toBe('') // tail solidified, no reflow leftovers
    await page.locator('.voice-pill').click()
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(false)

    // Mixing typing + speech: append in the editable textarea (reviewing state).
    await page.locator('[data-test="voice-flyout-input"]').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' now')
    await expect.poll(async () => (await voiceState(page)).draft).toBe(`${STUB_FINAL} now`)

    await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
    await page.locator('[data-test="voice-flyout-send"]').click()

    // Exact PTY bytes: the paste chunk(s) carry the text (bracketed markers allowed),
    // and the LAST chunk is a lone discrete \r — never text+\r in one write.
    await expect
      .poll(async () => (await chunks(page, id)).join(''), { timeout: 10_000 })
      .toContain(`${STUB_FINAL} now`)
    await expect
      .poll(async () => {
        const c = await chunks(page, id)
        return c[c.length - 1]
      })
      .toBe('\r')
    const all = await chunks(page, id)
    for (const c of all.slice(0, -1))
      expect(c, 'no \\r outside the submit write').not.toContain('\r')

    // Consumed: draft cleared, flyout closed.
    const after = await voiceState(page)
    expect(after.draft).toBe('')
    expect(after.flyoutOpen).toBe(false)
  })

  test('Insert pastes only — zero \\r reaches the PTY', async ({ page }) => {
    const id = await seedTarget(page)
    await dictateFinal(page)
    await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
    await page.locator('[data-test="voice-flyout-insert"]').click()
    await expect
      .poll(async () => (await chunks(page, id)).join(''), { timeout: 10_000 })
      .toContain(STUB_FINAL)
    // Give a would-be submit timer time to (wrongly) fire, then assert it never did.
    await page.waitForTimeout(400)
    for (const c of await chunks(page, id)) {
      expect(c, 'Insert must never emit \\r').not.toContain('\r')
    }
  })

  test('hotkey Ctrl+Shift+M toggles — including while the terminal owns focus', async ({
    page
  }) => {
    const id = await seedTarget(page)
    // The primary flow: hands in the terminal (xterm stopPropagation()s bubble keydown —
    // the pill listens in the capture phase).
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await page.keyboard.press('Control+Shift+M')
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(true)
    await page.keyboard.press('Control+Shift+M')
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(false)
  })

  test('drag repositions with real pointer input and never toggles the mic', async ({ page }) => {
    await seedTarget(page)
    const pill = page.locator('.voice-pill')
    const before = await pill.boundingBox()
    expect(before).toBeTruthy()
    const cx = before!.x + before!.width / 2
    const cy = before!.y + before!.height / 2
    // Real OS-path pointer events (memory: synthetic dispatchEvent false-greens on
    // CSS-transformed targets) — move well past the 4px click threshold.
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 120, cy - 80, { steps: 8 })
    await page.mouse.up()
    const after = await pill.boundingBox()
    expect(Math.round(after!.x)).not.toBe(Math.round(before!.x))
    expect((await voiceState(page)).capturing).toBe(false) // drag is not a click
    // Drag back: the position persists to the SHARED userData voice-config.json, so leave
    // no cross-run drift for later specs/runs (the sticky-prefs isolation class).
    await page.mouse.move(cx - 120, cy - 80)
    await page.mouse.down()
    await page.mouse.move(cx, cy, { steps: 8 })
    await page.mouse.up()
    expect((await voiceState(page)).capturing).toBe(false)
  })

  test('no-target: clearing the selection disables injection but keeps the draft', async ({
    page
  }) => {
    await seedTarget(page)
    await dictateFinal(page)
    await evalIn(page, `window.__canvasE2E.setSelection([])`)
    await expect(page.locator('[data-test="voice-flyout-notarget"]')).toBeVisible({
      timeout: 5_000
    })
    expect((await voiceState(page)).draft).toBe(STUB_FINAL) // draft survives retarget-to-nothing
  })
})

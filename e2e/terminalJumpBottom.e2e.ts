// e2e/terminalJumpBottom.e2e.ts
//
// Phase 5 · S4 — jump-to-bottom badge. The badge floats bottom-right of the terminal well,
// HIDDEN at the live tail and SHOWN while scrolled above it; clicking it snaps back to the
// bottom and hides it again. Uses an `exit`-launched (dead) PTY so the live shell can't race
// the buffer (the terminalScrollback.e2e pattern), fills the buffer past one viewport, then
// drives scroll via the e2e seam (scrollTerminal) and reads geometry via terminalScrolledUp.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, pollCall, seed } from './helpers'

// Typed VALUE readers — the id crosses as a real argument (structured clone), never spliced into
// an eval'd code string (CodeQL js/bad-code-sanitization).
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })
const scrolledUp = (page: Page, id: string): Promise<boolean> =>
  callE2E<boolean>(page, { m: 'terminalScrolledUp', a: [id] })
// 120 wrapping lines — comfortably more than any viewport, so there's scrollback to scroll into.
// Built HERE and passed to `resetTerminalWrite` as an argument (it used to be a generator
// expression evaluated in the page — the same code-string sink the ids were).
const WRITE_LINES = Array.from(
  { length: 120 },
  (_, i) => 'L' + String(i).padStart(3, '0') + '=' + 'x'.repeat(70)
).join('\r\n')
const BADGE = '[data-test="terminal-jump"]'

/** Poll a predicate over the terminal buffer text — the comparison runs HERE in Node. Same
 *  boolean contract as `pollEval`. */
async function pollBuf(
  page: Page,
  id: string,
  pred: (b: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await readBuf(page, id)), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

/** `pollBuf` for the scrolled-up flag. */
async function pollScrolledUp(
  page: Page,
  id: string,
  pred: (v: boolean) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => pred(await scrolledUp(page, id)), { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal jump-to-bottom badge (S4)', () => {
  test('hidden at the tail; shown scrolled up; click snaps to the bottom', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    expect(
      await pollBuf(page, id, (b) => (b || '').includes('process exited'), 8000),
      'shell exited (PTY drained — no further output to race)'
    ).toBe(true)
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, WRITE_LINES] })
    expect(
      await pollBuf(page, id, (b) => ((b ?? '').match(/L\d{3}/g) || []).length === 120, 6000),
      'buffer filled with 120 lines'
    ).toBe(true)

    // Writing auto-scrolls to the tail → not scrolled up, badge absent.
    expect(await scrolledUp(page, id), 'at the tail right after the write').toBe(false)
    await expect(page.locator(BADGE)).toHaveCount(0)

    // Scroll up into the scrollback → scrolled up, badge appears (Playwright retries until React paints).
    await callE2E(page, { m: 'scrollTerminal', a: [id, -50] })
    expect(
      await pollScrolledUp(page, id, (v) => v === true, 4000),
      'now scrolled above the tail'
    ).toBe(true)
    await expect(page.locator(BADGE)).toBeVisible()

    // Click the badge → snap to the bottom; it self-hides.
    await page.locator(BADGE).click()
    expect(
      await pollScrolledUp(page, id, (v) => v === false, 4000),
      'snapped back to the tail'
    ).toBe(true)
    await expect(page.locator(BADGE)).toHaveCount(0)
  })
})

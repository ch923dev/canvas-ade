// e2e/terminalJumpBottom.e2e.ts
//
// Phase 5 · S4 — jump-to-bottom badge. The badge floats bottom-right of the terminal well,
// HIDDEN at the live tail and SHOWN while scrolled above it; clicking it snaps back to the
// bottom and hides it again. Uses an `exit`-launched (dead) PTY so the live shell can't race
// the buffer (the terminalScrollback.e2e pattern), fills the buffer past one viewport, then
// drives scroll via the e2e seam (scrollTerminal) and reads geometry via terminalScrolledUp.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const readBuf = (id: string): string => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
const scrolledUp = (id: string): string =>
  `window.__canvasE2E.terminalScrolledUp(${JSON.stringify(id)})`
// 120 wrapping lines — comfortably more than any viewport, so there's scrollback to scroll into.
const WRITE_LINES = `Array.from({length: 120}, (_, i) => 'L' + String(i).padStart(3,'0') + '=' + 'x'.repeat(70)).join('\\r\\n')`
const BADGE = '[data-test="terminal-jump"]'

test.describe('@terminal jump-to-bottom badge (S4)', () => {
  test('hidden at the tail; shown scrolled up; click snaps to the bottom', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
      'shell exited (PTY drained — no further output to race)'
    ).toBe(true)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, ${WRITE_LINES})`
    )
    expect(
      await pollEval(page, `(${readBuf(id)}.match(/L\\d{3}/g) || []).length === 120`, 6000),
      'buffer filled with 120 lines'
    ).toBe(true)

    // Writing auto-scrolls to the tail → not scrolled up, badge absent.
    expect(await evalIn<boolean>(page, scrolledUp(id)), 'at the tail right after the write').toBe(
      false
    )
    await expect(page.locator(BADGE)).toHaveCount(0)

    // Scroll up into the scrollback → scrolled up, badge appears (Playwright retries until React paints).
    await evalIn(page, `window.__canvasE2E.scrollTerminal(${JSON.stringify(id)}, -50)`)
    expect(await pollEval(page, scrolledUp(id), 4000), 'now scrolled above the tail').toBe(true)
    await expect(page.locator(BADGE)).toBeVisible()

    // Click the badge → snap to the bottom; it self-hides.
    await page.locator(BADGE).click()
    expect(
      await pollEval(page, `${scrolledUp(id)} === false`, 4000),
      'snapped back to the tail'
    ).toBe(true)
    await expect(page.locator(BADGE)).toHaveCount(0)
  })
})

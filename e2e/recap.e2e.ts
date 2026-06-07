import { test, expect } from './fixtures'
import { mainCall, seed } from './helpers'

/**
 * Terminal-recap T16: the deterministic flip-to-recap proof. Seed a terminal board, write a
 * canned `board-<id>.md` into the temp project's `.canvas/memory/` (so the renderer's
 * `window.api.memory.readBoards([id])` — RecapView's loader — returns it), flip the board to
 * its recap back-face, and assert RecapView renders the NOW line + a timeline line.
 *
 * No network LLM: the recap prose is the canned md, written MAIN-side via the CANVAS_E2E-gated
 * `__canvasE2EMain.writeRecapMd` registry method (reached via `mainCall`, mirroring how
 * recovery.e2e.ts reaches MAIN). The repo selects on `data-test` (not data-testid), so the
 * flip control + recap body are queried with `[data-test="..."]` locators.
 */
test('flip shows the recap for a terminal board', async ({ page, electronApp }) => {
  // (a) seed a terminal board + write a canned recap md via the MAIN e2e seam.
  const id = await seed(page, 'terminal', { launchCommand: 'claude', agentTranscriptPath: 'x' })
  const wrote = await mainCall<boolean>(
    electronApp,
    'writeRecapMd',
    id,
    '# T\n\n**Now:** Reviewing auth; resume -> refresh-token\n\n- 14:32 — review auth\n'
  )
  expect(wrote, 'canned recap md persisted to the temp project .canvas/memory/').toBe(true)

  // (b) flip: click the flip control, assert RecapView shows NOW + a timeline line.
  await page.locator(`[data-test="flip-${id}"]`).click()
  await expect(page.locator('[data-test="recap-body"]')).toContainText('Reviewing auth')
  await expect(page.locator('[data-test="recap-body"]')).toContainText('14:32 — review auth')
})

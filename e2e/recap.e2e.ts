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
 *
 * Isolation: we explicitly createTempProject so the dir is known and can be torn down in a
 * finally block — same pattern as recovery.e2e.ts. writeRecapMd's self-minting fallback
 * (writeRecapMdToCurrentProject) is harmless but would leave currentDir set and the tmp dir
 * on disk; the explicit teardownProject here prevents that leak into later same-worker tests.
 */
test('flip shows the recap for a terminal board', async ({ page, electronApp }) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-e2e-', 'recap-e2e')
  try {
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
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

/**
 * Double-click flip: double-clicking the terminal flips it to the recap (overriding React
 * Flow's node-double-click focus), and double-clicking the recap flips it back. Proves the
 * onDoubleClick trigger + the fold animation settle (the recap overlay actually mounts and
 * later unmounts). We offset the first double-click off-center so it lands on the terminal
 * surface, not the centered idle "Start" button (double-clicks on buttons are guarded out).
 */
test('double-click flips a terminal to its recap and back', async ({ page, electronApp }) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'recap-dbl-', 'recap-dbl')
  try {
    const id = await seed(page, 'terminal', { launchCommand: 'claude', agentTranscriptPath: 'x' })
    const wrote = await mainCall<boolean>(
      electronApp,
      'writeRecapMd',
      id,
      '# T\n\n**Now:** Reviewing auth; resume -> refresh-token\n\n- 14:32 — review auth\n'
    )
    expect(wrote, 'canned recap md persisted to the temp project .canvas/memory/').toBe(true)

    const node = page.locator(`.react-flow__node[data-id="${id}"]`)
    const recap = page.locator('[data-test="recap-body"]')

    // Double-click the terminal surface (off-center, away from the title-bar + Start button)
    // → flips to the recap. expect() auto-waits through the ~300ms fold.
    await node.dblclick({ position: { x: 40, y: 80 } })
    await expect(recap).toContainText('Reviewing auth')

    // Double-click the recap body → flips back; the recap overlay unmounts.
    await recap.dblclick()
    await expect(recap).toHaveCount(0)
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

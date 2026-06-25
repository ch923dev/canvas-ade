import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Test-isolation contract for `window.__canvasE2E.reset()`. `reset()` is the per-test
 * clean-slate hook (the page fixture's beforeEach). A clean slate must include "a project
 * is open and the canvas is mounted" — NOT just "no boards". With workers:1, Playwright
 * reuses ONE Electron app across all spec files, so any spec that drives the app to
 * `status:'error'` (the WelcomeScreen recovery card — see recovery.e2e.ts) leaves the
 * canvas UNMOUNTED. Before this guard, `reset()` cleared the store but left `status:'error'`,
 * so the FIRST test of the next spec in the worker (alphabetically `terminal`) seeded a
 * board that never rendered and timed out — a real isolation bug that `retries:2` masked
 * (the retry runs in a fresh worker). This pins the contract deterministically.
 */
test.describe('@core reset() clean-slate contract (test isolation)', () => {
  // envelope-valid but deep-corrupt: primary AND .bak too-new → unrecoverable → status:'error'.
  const TOO_NEW = '{"schemaVersion":999999,"boards":[]}'

  test('reset() re-mounts the canvas after the app was driven to status:error', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'iso-err-', 'iso-err')
    try {
      // Drive the app into the unrecoverable error state (WelcomeScreen, canvas unmounted),
      // exactly as recovery.e2e.ts does — this is the state that leaks across specs.
      await mainCall(electronApp, 'writeProjectFile', tmp, '.canvas/canvas.json', TOO_NEW)
      await mainCall(electronApp, 'writeProjectFile', tmp, '.canvas/canvas.json.bak', TOO_NEW)
      const res = await evalIn<{ status: string }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(res.status, 'precondition: app is on the error WelcomeScreen').toBe('error')
      expect(
        await evalIn<boolean>(page, `document.querySelector('.react-flow__viewport') === null`),
        'precondition: canvas is unmounted on error'
      ).toBe(true)

      // reset() must restore the clean slate: canvas mounted + a seeded board renders.
      await evalIn(page, 'window.__canvasE2E.reset()')
      const id = await seed(page, 'planning')
      const rendered = await pollEval(
        page,
        `document.querySelector('.react-flow__node[data-id=${JSON.stringify(id)}]') !== null`,
        4000
      )
      expect(rendered, 'seeded board renders after reset() (canvas re-mounted)').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  // Cross-spec "library-panel-overlap" guard. The Project Library panel is a fixed 320px right-docked
  // overlay (z-index 70). Its open state lives in libraryStore so reset() can close it; before that it
  // was panel-local useState that reset() could not reach, so browserLibrary left it open and it
  // occluded the next @preview spec's real-click target (browserNetwork "Close inspector"), failing
  // only in-suite (passing in isolation / on retry in a fresh worker). Pin the close here.
  test('reset() closes a left-open Project Library panel (cross-spec overlap guard)', async ({
    page
  }) => {
    // Open it via its reopen tab — the exact path browserLibrary takes to leak it open.
    await evalIn(page, `document.querySelector('[data-test="library-open"]').click()`)
    expect(
      await pollEval(
        page,
        `document.querySelector('[data-test="library-panel"]').getAttribute('data-open') === 'true'`,
        3000
      ),
      'precondition: the Library panel opened'
    ).toBe(true)

    // reset() (the per-test isolation hook) must close it so it cannot leak into the next spec.
    await evalIn(page, 'window.__canvasE2E.reset()')
    expect(
      await pollEval(
        page,
        `document.querySelector('[data-test="library-panel"]').getAttribute('data-open') === 'false'`,
        3000
      ),
      'reset() closed the Library panel'
    ).toBe(true)
  })
})

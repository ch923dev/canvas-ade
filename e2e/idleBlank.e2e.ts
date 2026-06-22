import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * REGRESSION (PR #210 idle-page blank) — the OSR browser preview must paint an IDLE (static) page
 * once and have that frame STICK with the Network panel CLOSED, with NO toggle.
 *
 * Root cause (fixed): `registerCrashReadyGate`'s onReady called `wc.startPainting()` with NO paired
 * `wc.invalidate()`, unlike `applyOsrPaint`'s resume path (startPainting + invalidate). On main that
 * was reliable because nothing else ran on the did-finish-load tick. PR #210 added `wireOsrNetwork`,
 * whose did-finish-load `armOsrNetwork` (Network.enable + Target.setAutoAttach) fires CDP on the SAME
 * tick immediately before startPainting — which can consume/defer Chromium's single implicit
 * begin-frame for an idle page, so the host <canvas> stayed blank until a resize invalidate (the
 * "appears when I toggle the Network panel" workaround). The fix pairs invalidate() with
 * startPainting() in onReady (and adds the settle-invalidate safety net to the initial size drain).
 *
 * WHY A STATIC PAGE: the default localServer clock page repaints every second (setInterval), so a
 * "blank until a resize" defect self-heals on the next tick and is structurally invisible to every
 * browser/fullview/network e2e. The `/static` route (localServer.ts) paints ONCE then is idle — the
 * only page that can expose "did the first frame stick?".
 *
 * WHY A CONTRACT SPY (test 2): the live failure is a timing-dependent CDP scheduler race and did NOT
 * surface under headless Windows OSR — `startPainting()` reliably emits a frame here, so a
 * pixel-level "stays blank" assertion cannot be driven RED in this environment (confirmed
 * empirically). What IS deterministic everywhere is the code path: WITH the fix onReady pairs
 * `invalidate()` with `startPainting()`; WITHOUT it, it does not. Test 2 re-fires the board's
 * did-finish-load (`osrReplayReadyInvalidations`), re-running the PRODUCTION onReady over a live,
 * already-loaded idle board while spying on `wc.invalidate`, and asserts onReady called invalidate()
 * at least once — RED-without (0 calls), GREEN-with (≥1). Test 1 keeps the real pixel pipeline honest
 * (an idle page paints + sticks with the panel closed) and guards the happy path the fix must not
 * break.
 *
 * @preview
 */
const runtimeStatus = (id: string, status: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`
const osrNonBlank = (id: string): string =>
  `window.__canvasE2E.osrCanvasNonBlank(${JSON.stringify(id)})`

const idleUrl = async (electronApp: Parameters<typeof mainCall>[0]): Promise<string> => {
  const base = await mainCall<string>(electronApp, 'localUrl')
  return base.replace(/\/$/, '') + '/static'
}

test.describe('@preview idle (static) page OSR paint reliability', () => {
  test('an idle static page paints + sticks WITHOUT a network-panel toggle', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'browser', { url: await idleUrl(electronApp) })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

    // Reaches connected (did-finish-load) — the gate every browser e2e uses.
    expect(
      await pollEval(page, runtimeStatus(id, 'connected'), 12_000),
      'idle page connected'
    ).toBe(true)

    // Measure WITHOUT ever touching the Network panel (the workaround). The canvas must be non-blank
    // AND the offscreen pump must be live.
    const painted = await pollEval(page, osrNonBlank(id), 8000)
    const paintingMain = await mainCall<boolean | null>(electronApp, 'osrPainting', id)
    const nonBlank = await evalIn<boolean>(page, osrNonBlank(id))
    console.log(
      `[idleblank/open] connected — osrPainting(main)=${paintingMain} nonBlank=${nonBlank} (poll8s=${painted})`
    )

    expect(nonBlank, 'idle static page is non-blank with the panel CLOSED, no toggle').toBe(true)
    expect(paintingMain, 'offscreen pump is live for a visible idle board').toBe(true)
  })

  test('onReady forces a repaint invalidate() on the first-ready path (RED without the fix)', async ({
    page,
    electronApp
  }) => {
    // Open + paint an idle board (the same env-reliable path as above).
    const id = await seed(page, 'browser', { url: await idleUrl(electronApp) })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(
      await pollEval(page, runtimeStatus(id, 'connected'), 12_000),
      'idle page connected'
    ).toBe(true)
    expect(await pollEval(page, osrNonBlank(id), 8000), 'idle page painted on open').toBe(true)

    // Re-fire the board's did-finish-load → re-run the PRODUCTION onReady (registerCrashReadyGate)
    // over the live, already-loaded idle page, spying on wc.invalidate. The contract the fix
    // restores is that onReady pairs invalidate() with startPainting() (mirroring applyOsrPaint's
    // resume path) so an idle page that missed its implicit begin-frame still gets one fresh frame.
    //   - WITHOUT the fix: onReady calls startPainting() only → 0 invalidate() calls (RED).
    //   - WITH the fix:    onReady calls startPainting() + invalidate() → ≥1 invalidate() call (GREEN).
    const invalidations = await mainCall<number>(electronApp, 'osrReplayReadyInvalidations', id)
    console.log(`[idleblank/contract] onReady invalidate() calls = ${invalidations}`)

    expect(invalidations, 'replay-ready spy ran (OSR window present)').toBeGreaterThanOrEqual(0)
    expect(
      invalidations,
      'onReady pairs invalidate() with startPainting() on the first-ready path (idle-blank guard)'
    ).toBeGreaterThanOrEqual(1)
  })
})

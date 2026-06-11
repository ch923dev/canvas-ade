// e2e/terminalCrisp.e2e.ts — terminal raster fix (docs/research/2026-06-11-terminal-font-blur.md).
// Pins the levers that keep terminal text crisp on the zoomable canvas:
//   1. renderer policy — the WebGL addon (fixed-dpr bitmap, resampled blurry by the
//      camera at z ≠ 1) is held ONLY at a crisp settled zoom; any other settled zoom
//      falls back to xterm's DOM renderer (Chromium re-rasters DOM text sharp at rest);
//   2. zoom snap — a settled zoom inside [ZOOM_SNAP_LO, ZOOM_SNAP_HI] lands on exactly 1;
//   3. failed-attach sweep — a GL activation that throws after appending its canvas
//      (software GL: passes the GL2 check, dies in shader setup) must not leak a dead
//      canvas per retry.
//
// Renderer discriminator: `.xterm-rows` is created by xterm's DOM renderer and REMOVED
// on its dispose, so rows-present ⇔ DOM renderer painting and rows-absent ⇔ WebGL
// painting. Deliberately NOT the <canvas> element: a failed GL activation can orphan a
// dead canvas in .xterm-screen (the Linux-leg diagnosis), so canvas-presence lies.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const screenSel = (id: string): string => `.react-flow__node[data-id="${id}"] .xterm-screen`
const domRowsActive = (id: string): string =>
  `!!document.querySelector(${JSON.stringify(`${screenSel(id)} .xterm-rows`)})`
const canvasCount = (id: string): string =>
  `document.querySelectorAll(${JSON.stringify(`${screenSel(id)} canvas`)}).length`

/** Drive the camera to `z` and wait for the live zoom to land there. */
async function zoomTo(page: Parameters<typeof evalIn>[0], z: number): Promise<void> {
  await evalIn(page, `window.__canvasE2E.setZoom(${z})`)
  await pollEval(page, `Math.abs(window.__canvasE2E.getZoom() - ${z}) < 1e-6`, 3_000)
}

test.describe('terminal crisp-zoom policy', () => {
  test('WebGL releases at a non-crisp settled zoom and re-attaches at 100%', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
    await zoomTo(page, 1)

    // WebGL active ⇔ the DOM renderer's rows container was disposed. If rows persist
    // at crisp zoom, GL is unavailable/broken in this environment (the addon's
    // activation fails and xterm stays on the DOM renderer) — the policy is then
    // unobservable; skip rather than fail on the environment. Generous window:
    // settle debounce + software-GL context minting under cold-container load.
    const glActive = await pollEval(page, `!(${domRowsActive(id)})`, 10_000)
    test.skip(!glActive, 'WebGL unavailable in this environment — renderer policy unobservable')

    await zoomTo(page, 1.3)
    const released = await pollEval(page, domRowsActive(id), 10_000)
    expect(released, 'DOM renderer painting at settled zoom 1.3 (GL released)').toBe(true)

    await zoomTo(page, 1)
    const reattached = await pollEval(page, `!(${domRowsActive(id)})`, 10_000)
    expect(reattached, 'WebGL painting again once the zoom settled back at 1').toBe(true)
  })

  test('zoom cycles never accumulate renderer canvases (failed GL attaches are swept)', async ({
    page
  }) => {
    // Runs on BOTH legs: with working GL there is exactly the one live canvas; with
    // broken GL (the Linux container) every cycle retries the attach and the sweep
    // must remove what the failed attempt appended — pre-sweep this grew 1 → 2 → 3.
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
    for (const z of [1, 1.3, 1, 1.3, 1]) {
      await zoomTo(page, z)
      await page.waitForTimeout(500) // let the settle (250ms) + renderer swap land
    }
    const count = await evalIn<number>(page, canvasCount(id))
    expect(
      count,
      'at most the one live WebGL canvas after repeated zoom cycles'
    ).toBeLessThanOrEqual(1)
  })

  test('a settled zoom inside the snap band lands on exactly 100%', async ({ page }) => {
    // Snap needs no board, but seed one so the canvas matches real use.
    await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await evalIn(page, `window.__canvasE2E.setZoom(0.97)`)
    const snapped = await pollEval(page, `window.__canvasE2E.getZoom() === 1`, 3_000)
    expect(snapped, 'settled 0.97 snapped to exactly 1').toBe(true)
  })

  test('a settled zoom outside the band is left untouched', async ({ page }) => {
    await evalIn(page, `window.__canvasE2E.setZoom(1.3)`)
    // Wait past the settle window, then assert the zoom did NOT move.
    await page.waitForTimeout(800)
    const zoom = await evalIn<number>(page, `window.__canvasE2E.getZoom()`)
    expect(zoom).toBeCloseTo(1.3, 5)
  })
})

// e2e/terminalCrisp.e2e.ts — terminal raster fix (docs/research/2026-06-11-terminal-font-blur.md).
// Pins the two levers that keep terminal text crisp on the zoomable canvas:
//   1. renderer policy — the WebGL addon (fixed-dpr bitmap, resampled blurry by the
//      camera at z ≠ 1) is held ONLY at a crisp settled zoom; any other settled zoom
//      falls back to xterm's DOM renderer (Chromium re-rasters DOM text sharp at rest);
//   2. zoom snap — a settled zoom inside [ZOOM_SNAP_LO, ZOOM_SNAP_HI] lands on exactly 1.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

/** WebGL renderer discriminator: the webgl addon mounts a <canvas> inside .xterm-screen;
 *  the DOM renderer paints rows as spans (no canvas). Same probe the blur review used. */
const hasGlCanvas = (id: string): string =>
  `!!document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${id}"] .xterm-screen canvas`)})`

test.describe('terminal crisp-zoom policy', () => {
  test('WebGL releases at a non-crisp settled zoom and re-attaches at 100%', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await pollEval(page, `window.__canvasE2E.getZoom() === 1`, 3_000)

    // GL may be genuinely unavailable in a software-GL environment (the addon's
    // try/catch falls back to the DOM renderer) — then the policy is unobservable
    // here; skip rather than fail on the environment. Generous window: the swap
    // waits out the settle debounce, and software GL under cold-container load
    // (the Linux Docker leg) can take seconds to mint a context.
    const glAvailable = await pollEval(page, hasGlCanvas(id), 10_000)
    test.skip(!glAvailable, 'WebGL unavailable in this environment — renderer policy unobservable')

    await evalIn(page, `window.__canvasE2E.setZoom(1.3)`)
    await pollEval(page, `window.__canvasE2E.getZoom() !== 1`, 3_000)
    const released = await pollEval(page, `!(${hasGlCanvas(id)})`, 10_000)
    expect(released, 'GL canvas released at settled zoom 1.3 (DOM renderer takes over)').toBe(true)

    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await pollEval(page, `window.__canvasE2E.getZoom() === 1`, 3_000)
    const reattached = await pollEval(page, hasGlCanvas(id), 10_000)
    expect(reattached, 'GL canvas re-attached once the zoom settled back at 1').toBe(true)
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

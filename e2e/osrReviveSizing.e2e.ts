import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

// Regression guard — MAX_LIVE revive sizing. An evicted (over-cap) Browser board's offscreen window
// is destroyed and REOPENED at the OSR default (1280×800, S=1) when it climbs back into the cap. The
// bug: useOffscreenSizing did not re-push the size on revive (its effect deps excluded the `alive`
// flag), so the revived board reflowed at desktop width in a mobile frame + lost its supersample until
// the next zoom-settle. The fix reads `alive` and re-sends the preset size on revive. This drives the
// `alive` flag directly (what the liveness manager writes on evict/revive) to exercise the exact
// open/close → re-size path deterministically, without staging >4 boards and a pan.

type OsrSize = {
  physW: number
  physH: number
  zoom: number
  logicalW: number
  logicalH: number
} | null

const runtimeStatus = (id: string, status: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

test.describe('@preview OSR revive keeps the preset logical width (MAX_LIVE regression)', () => {
  test('a revived mobile board re-sizes to its preset, not the 1280 desktop default', async ({
    page,
    electronApp
  }) => {
    const projDir = await mainCall<string>(electronApp, 'createTempProject', 'osrrev-', 'osrrev')
    try {
      const url = await mainCall<string>(electronApp, 'localUrl')
      // MOBILE preset → the offscreen page's logical (CSS) width should be 390.
      const id = await seed(page, 'browser', { url, viewport: 'mobile' })
      expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000), 'connected').toBe(true)

      // Wait for the mount-time sizing send to land the mobile preset (the window is BORN at the 1280
      // default, then resized to 390 shortly after mount). Poll until it settles below desktop width.
      await expect
        .poll(async () => (await mainCall<OsrSize>(electronApp, 'osrLogicalSize', id))?.logicalW, {
          timeout: 8000
        })
        .toBeLessThan(1000)
      const base = await mainCall<OsrSize>(electronApp, 'osrLogicalSize', id)
      expect(base, 'window sized at baseline').not.toBeNull()

      // ── EVICT: the manager writes alive=false → useOffscreenPreview closes the window (frozen frame
      //    stays on the <canvas>). The OSR window should be gone.
      await evalIn(page, `window.__canvasE2E.setOsrAlive(${JSON.stringify(id)}, false)`)
      await expect
        .poll(() => mainCall<OsrSize>(electronApp, 'osrLogicalSize', id), { timeout: 5000 })
        .toBeNull()

      // ── REVIVE: the manager writes alive=true → useOffscreenPreview reopens the window (born at the
      //    1280 default) AND useOffscreenSizing re-pushes the preset size (the fix).
      await evalIn(page, `window.__canvasE2E.setOsrAlive(${JSON.stringify(id)}, true)`)
      await expect
        .poll(() => mainCall<OsrSize>(electronApp, 'osrLogicalSize', id), { timeout: 8000 })
        .not.toBeNull()

      // The revived board must settle back to its mobile preset width — NOT stick at the 1280 default.
      await expect
        .poll(async () => (await mainCall<OsrSize>(electronApp, 'osrLogicalSize', id))?.logicalW, {
          timeout: 8000
        })
        .toBe(base?.logicalW)
    } finally {
      await mainCall(electronApp, 'teardownProject', projDir)
    }
  })
})

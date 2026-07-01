import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { mainCall, seed } from './helpers'

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

// The e2e renderer-harness surface this spec drives (installed on the window under isE2E). The board id
// is passed as a BOUND page.evaluate argument rather than interpolated into an eval'd string, so no code
// is constructed from data (the recommended Playwright pattern). Each callback runs IN the browser and
// can't close over a Node-scope helper, so the harness access is inlined per-callback; the type cast is
// erased, leaving a plain `globalThis.__canvasE2E.*` call.
interface CanvasE2EProbe {
  getRuntime(id: string): { status: string } | null
  setOsrAlive(id: string, alive: boolean): void
}

const statusOf = (page: Page, id: string): Promise<string | null> =>
  page.evaluate(
    (bid) =>
      (globalThis as unknown as { __canvasE2E: CanvasE2EProbe }).__canvasE2E.getRuntime(bid)
        ?.status ?? null,
    id
  )

const setAlive = (page: Page, id: string, alive: boolean): Promise<void> =>
  page.evaluate(
    (arg) =>
      (globalThis as unknown as { __canvasE2E: CanvasE2EProbe }).__canvasE2E.setOsrAlive(
        arg.id,
        arg.alive
      ),
    { id, alive }
  )

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
      await expect.poll(() => statusOf(page, id), { timeout: 12_000 }).toBe('connected')

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
      await setAlive(page, id, false)
      await expect
        .poll(() => mainCall<OsrSize>(electronApp, 'osrLogicalSize', id), { timeout: 5000 })
        .toBeNull()

      // ── REVIVE: the manager writes alive=true → useOffscreenPreview reopens the window (born at the
      //    1280 default) AND useOffscreenSizing re-pushes the preset size (the fix).
      await setAlive(page, id, true)
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

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { apiCall, callE2E, mainCall, pollCall, seed } from './helpers'

// SLICE-005 regression guard: the OSR paint dirty-rect crop now applies at supersample > 1 too
// (the dirtyRect is in device-px == the image surface; empirically verified). This asserts that the
// S=2 crop path keeps the preview coherent — frames still flow and the canvas re-fills + stays
// non-blank across cropped partial paints. (Pixel-exact placement is guaranteed by the device-px
// dirtyRect invariant + the unchanged renderer blit, which already crops at S=1; this is the
// integration safety net that a future change to the crop coord space can't silently break.)
const runtimeOf = (page: Page, id: string): Promise<{ status: string } | null> =>
  callE2E<{ status: string } | null>(page, { m: 'getRuntime', a: [id] })

/** Poll until the runtime reaches `status` — the comparison runs HERE in Node, so neither the
 *  seeded id nor the wanted status ever enters page code. Same boolean contract as `pollEval`. */
async function pollStatus(
  page: Page,
  id: string,
  status: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => (await runtimeOf(page, id))?.status === status, { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}
const pollNonBlank = (page: Page, id: string, timeoutMs: number): Promise<boolean> =>
  pollCall(page, [{ m: 'osrCanvasNonBlank', a: [id] }], timeoutMs)

test.describe('@preview OSR dirty-rect crop at supersample > 1 (SLICE-005)', () => {
  test('preview stays coherent when frames are cropped at S=2', async ({ page, electronApp }) => {
    const projDir = await mainCall<string>(electronApp, 'createTempProject', 'osrcrop-', 'osrcrop')
    try {
      const url = await mainCall<string>(electronApp, 'localUrl')
      const id = await seed(page, 'browser', { url, viewport: 'desktop' })
      expect(await pollStatus(page, id, 'connected', 12_000), 'connected').toBe(true)
      expect(await pollNonBlank(page, id, 8000), 'painted before S=2').toBe(true)

      // Force supersample 2 → exercises the S>1 crop path. invalidate() yields a full repaint at the
      // 2× surface, then the page's ongoing paints arrive as cropped device-px sub-rects.
      await apiCall(page, 'resizeOsr', id, { logicalW: 1280, logicalH: 800, supersample: 2 })
      // The canvas must re-fill at the new 2× surface and remain coherent across the cropped partials
      // (a broken crop offset would blank or corrupt the canvas → the non-uniform check would fail).
      await page.waitForTimeout(800)
      expect(await pollNonBlank(page, id, 8000), 'canvas coherent after S=2 cropped frames').toBe(
        true
      )

      // Ground truth: the offscreen page still renders + captures at S=2 (independent of the crop path).
      const shot = await apiCall<{ ok: boolean }>(page, 'screenshotPreview', id)
      expect(shot.ok, 'screenshot ok at S=2').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', projDir)
    }
  })
})

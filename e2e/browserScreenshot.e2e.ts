import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { apiCall, callE2E, mainCall, pollCall, seed } from './helpers'

/** The board's preview runtime, read as a VALUE (the id crosses as a real arg, never spliced). */
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

test.describe('@preview browser board — screenshot (OSR offscreen window)', () => {
  test('captures the live OSR preview to an assets/ PNG file', async ({ page, electronApp }) => {
    // Open a temp project so assets/ resolves.
    const projDir = await mainCall<string>(
      electronApp,
      'createTempProject',
      'screenshot-',
      'screenshot-test'
    )
    try {
      const url = await mainCall<string>(electronApp, 'localUrl')
      const id = await seed(page, 'browser', { url, viewport: 'desktop' })
      await page.waitForTimeout(150)
      await callE2E(page, { m: 'fitView', a: [id] })
      const connected = await pollStatus(page, id, 'connected', 12_000)
      expect(connected, 'connected before screenshot').toBe(true)
      // The OSR window must have painted before capturePage returns a non-blank frame; the
      // visible <canvas> going non-blank proves frames are flowing from the offscreen window.
      const painted = await pollNonBlank(page, id, 8000)
      expect(painted, 'OSR painted before screenshot').toBe(true)

      const res = await apiCall<{ ok: boolean; assetId: string | null }>(
        page,
        'screenshotPreview',
        id
      )
      expect(res.ok, 'screenshot ok').toBe(true)
      expect(res.assetId, 'assetId returned (project open)').toBeTruthy()

      // ADR 0009: the assetId is still the logical `assets/<sha>.png`, but the blob lives under
      // `<project>/.canvas/assets/`. Resolve the physical path through `.canvas/`.
      const abs = await mainCall<string>(electronApp, 'joinPath', projDir, '.canvas', res.assetId!)
      const exists = await mainCall<boolean>(electronApp, 'fileExists', abs)
      expect(exists, 'asset PNG written to disk under .canvas/').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', projDir)
    }
  })
})

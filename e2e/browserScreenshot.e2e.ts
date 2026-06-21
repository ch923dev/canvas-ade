import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`
const osrNonBlank = (id: string) => `window.__canvasE2E.osrCanvasNonBlank(${JSON.stringify(id)})`

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
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
      const connected = await pollEval(page, runtimeStatus(id, 'connected'), 12_000)
      expect(connected, 'connected before screenshot').toBe(true)
      // The OSR window must have painted before capturePage returns a non-blank frame; the
      // visible <canvas> going non-blank proves frames are flowing from the offscreen window.
      const painted = await pollEval(page, osrNonBlank(id), 8000)
      expect(painted, 'OSR painted before screenshot').toBe(true)

      const res = await evalIn<{ ok: boolean; assetId: string | null }>(
        page,
        `window.api.screenshotPreview(${JSON.stringify(id)})`
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

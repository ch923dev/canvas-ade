import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

test.describe('browser board — screenshot', () => {
  test('captures the live view → clipboard + assets/ file', async ({ page, electronApp }) => {
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
      await page.waitForTimeout(400) // settle paint so capturePage is non-blank

      const res = await evalIn<{ ok: boolean; assetId: string | null }>(
        page,
        `window.api.screenshotPreview(${JSON.stringify(id)})`
      )
      expect(res.ok, 'screenshot ok').toBe(true)
      expect(res.assetId, 'assetId returned (project open)').toBeTruthy()

      const abs = await mainCall<string>(electronApp, 'joinPath', projDir, res.assetId!)
      const exists = await mainCall<boolean>(electronApp, 'fileExists', abs)
      expect(exists, 'asset PNG written to disk').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', projDir)
    }
  })
})

import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

/**
 * E2 (evidence capture): a Browser board is a native WebContentsView that paints ABOVE
 * all HTML, so Playwright's own page.screenshot() is BLANK exactly where the browser
 * board is. The ONLY way to get visual evidence of native-view content is a MAIN-side
 * capturePage → disk. `captureViewToFile` is that primitive; this proves it end to end.
 */
test.describe('e2e evidence — native-view PNG to disk (captureViewToFile)', () => {
  test('writes a non-blank PNG of a live browser board to disk', async ({ page, electronApp }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'evid-', 'evidence')
    try {
      const url = await mainCall<string>(electronApp, 'localUrl')
      const id = await seed(page, 'browser', { url })
      await page.waitForTimeout(150)
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
      expect(
        await pollEval(page, runtimeStatus(id, 'connected'), 10_000),
        'browser connected'
      ).toBe(true)
      await page.waitForTimeout(300) // one paint before capture

      const pngPath = await mainCall<string>(electronApp, 'joinPath', tmp, 'browser-board.png')
      const wrote = await mainCall<boolean>(electronApp, 'captureViewToFile', id, pngPath)
      expect(wrote, 'captureViewToFile reported a non-blank write').toBe(true)
      expect(
        await mainCall<boolean>(electronApp, 'fileExists', pngPath),
        'PNG landed on disk'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('returns false (no write) for an unknown board id', async ({ electronApp }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'evid-', 'evidence')
    try {
      const pngPath = await mainCall<string>(electronApp, 'joinPath', tmp, 'nope.png')
      const wrote = await mainCall<boolean>(
        electronApp,
        'captureViewToFile',
        'no-such-board',
        pngPath
      )
      expect(wrote, 'no view → false').toBe(false)
      expect(await mainCall<boolean>(electronApp, 'fileExists', pngPath), 'nothing written').toBe(
        false
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})

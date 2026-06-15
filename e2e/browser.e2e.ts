import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`
// OS-3 Phase 5: the OSR replacement for the native `captureView → {empty}` probe — proves the
// offscreen frame actually reached the visible DOM <canvas> (reads its pixels in-renderer).
const osrNonBlank = (id: string) => `window.__canvasE2E.osrCanvasNonBlank(${JSON.stringify(id)})`

test.describe('@preview browser preview (OSR offscreen → canvas — real instance)', () => {
  test('connects + the OSR <canvas> paints a real (non-blank) frame', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const connected = await pollEval(page, runtimeStatus(id, 'connected'), 10_000)
    expect(connected, 'browser reaches connected').toBe(true)
    // The offscreen frame must land on the visible canvas (the regression surface OSR adds).
    // Poll, not single-shot — the first paint arrives a beat after `connected`.
    const painted = await pollEval(page, osrNonBlank(id), 8000)
    expect(painted, 'OSR canvas painted a non-blank frame').toBe(true)
  })

  test('refused URL ends as load-failed (not connected)', async ({ page }) => {
    const id = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const failed = await pollEval(page, runtimeStatus(id, 'load-failed'), 12_000)
    expect(failed, 'refused URL → load-failed').toBe(true)
  })
})

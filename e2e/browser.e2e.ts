import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeLive = (id: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === true; })()`
const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

test.describe('@preview browser preview (native WebContentsView — real instance)', () => {
  test('connects + a per-view capturePage is non-blank', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const connected = await pollEval(page, runtimeStatus(id, 'connected'), 10_000)
    expect(connected, 'browser reaches connected').toBe(true)
    await page.waitForTimeout(300) // one paint before capture
    const cap = await mainCall<{ attached: boolean; empty: boolean }>(
      electronApp,
      'captureView',
      id
    )
    expect(cap.attached, 'native view attached').toBe(true)
    expect(cap.empty, 'capture is non-blank').toBe(false)
  })

  test('node gesture detaches the live view → reattaches on end', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 10_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 5000)
    await evalIn(page, 'window.__canvasE2E.setGesture(true)')
    const detached = await pollEval(
      page,
      `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === false; })()`,
      5000
    )
    await evalIn(page, 'window.__canvasE2E.setGesture(false)')
    const reattached = await pollEval(page, runtimeLive(id), 8000)
    expect(detached, 'detached on gesture start').toBe(true)
    expect(reattached, 'reattached on gesture end').toBe(true)
  })

  test('focus elsewhere detaches the browser view → reattaches on unfocus', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    const termId = await seed(page, 'terminal', { launchCommand: 'echo focus' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, runtimeStatus(browserId, 'connected'), 10_000)).toBe(true)
    await pollEval(page, runtimeLive(browserId), 5000)
    await evalIn(page, `window.__canvasE2E.setFocus(${JSON.stringify(termId)})`)
    await page.waitForTimeout(500)
    const capFocused = await mainCall<{ attached: boolean }>(electronApp, 'captureView', browserId)
    await evalIn(page, 'window.__canvasE2E.setFocus(null)')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    const reattached = await pollEval(page, runtimeLive(browserId), 8000)
    expect(capFocused.attached, 'detached on focus').toBe(false)
    expect(reattached, 'reattached on unfocus').toBe(true)
  })

  test('refused URL ends as load-failed (not connected)', async ({ page }) => {
    const id = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const failed = await pollEval(page, runtimeStatus(id, 'load-failed'), 12_000)
    expect(failed, 'refused URL → load-failed').toBe(true)
  })
})

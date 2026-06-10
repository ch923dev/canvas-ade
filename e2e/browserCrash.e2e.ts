/**
 * D2-C: crashed-preview recovery. Drives the REAL render-process-gone path —
 * forcefullyCrashRenderer on the live native view's webContents — and asserts:
 *  1. the board surfaces `crashed` (status word + Reload CTA) instead of freezing
 *     silently (the audit §3.4 Medium-High finding);
 *  2. the Reload CTA relaunches the renderer and the board reconnects;
 *  3. the recovery reuses the SAME webContents (reload, not close+reopen — page
 *     partition/session survives).
 * The CTA click is a real Playwright click on the HTML state layer (the dead native
 * view is hidden by main on crash, so the HTML underneath is genuinely hittable).
 */
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

test.describe('browser board — crashed preview recovery (D2-C)', () => {
  test('render-process-gone → crashed state + Reload CTA reconnects', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 10_000), 'connects first').toBe(
      true
    )
    const wcBefore = await mainCall<number | null>(electronApp, 'viewWebContentsId', id)

    // Kill the preview's renderer process for real.
    const crashed = await mainCall<boolean>(electronApp, 'crashView', id)
    expect(crashed, 'crashView found the live view').toBe(true)
    expect(
      await pollEval(page, runtimeStatus(id, 'crashed'), 10_000),
      'board surfaces crashed (no silent freeze)'
    ).toBe(true)

    // The HTML state layer is hittable (main hid the dead native layer on crash).
    await expect(page.locator('.bb-conn-word')).toHaveText('crashed')
    const cta = page.locator('.bb-reload-btn')
    await expect(cta).toBeVisible()
    await cta.click()

    expect(
      await pollEval(page, runtimeStatus(id, 'connected'), 15_000),
      'Reload CTA relaunches the renderer and reconnects'
    ).toBe(true)
    // Reload (not close+reopen): the SAME webContents survives the crash recovery.
    const wcAfter = await mainCall<number | null>(electronApp, 'viewWebContentsId', id)
    expect(wcAfter, 'webContents id stable across crash recovery').toBe(wcBefore)
  })
})

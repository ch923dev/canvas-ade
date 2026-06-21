import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

/**
 * @preview — the DevTools Network inspector end-to-end (real OSR instance):
 * open the per-board inspector from its URL-bar toggle, confirm MAIN's always-on capture replays a
 * request row (the page's own document load), select it for the details pane, and confirm closing
 * the panel tears it down. Drives the REAL DOM (the user path), not a store shim.
 */
test.describe('@preview DevTools Network inspector (per board)', () => {
  test('toggle opens the panel, a captured request row appears + selects, close tears down', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const connected = await pollEval(page, runtimeStatus(id, 'connected'), 10_000)
    expect(connected, 'browser reaches connected').toBe(true)

    // The inspector is closed → its panel is absent (zero-IPC-when-closed).
    await expect(page.locator('.bb-net')).toHaveCount(0)

    // Open it from the URL-bar toggle (real click; the button stops propagation so RF won't pan).
    await page.getByRole('button', { name: 'Network inspector' }).click()
    await expect(page.locator('.bb-net'), 'panel opens on toggle').toBeVisible()

    // MAIN captured the document load always-on; subscribe replays it → at least one row.
    const firstRow = page.locator('.bb-net-row').first()
    await expect(firstRow, 'a captured request row appears').toBeVisible({ timeout: 8000 })

    // Selecting a row opens the details pane.
    await firstRow.click()
    await expect(page.locator('.bb-net-details'), 'details pane on row select').toBeVisible()
    await expect(page.locator('.bb-net-url')).toContainText('http')

    // Closing the panel tears it down (the toggle's accent state clears too).
    await page.getByRole('button', { name: 'Close inspector' }).click()
    await expect(page.locator('.bb-net'), 'panel closes').toHaveCount(0)
  })

  test('the dock switch flips the panel between bottom and right', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await page.getByRole('button', { name: 'Network inspector' }).click()
    // Default dock = bottom.
    await expect(page.locator('.bb-net.bb-net-bottom')).toBeVisible()
    // Switch to right.
    await page.getByRole('button', { name: 'Dock to right' }).click()
    await expect(page.locator('.bb-net.bb-net-right')).toBeVisible()
    await expect(page.locator('.bb-net.bb-net-bottom')).toHaveCount(0)
  })
})

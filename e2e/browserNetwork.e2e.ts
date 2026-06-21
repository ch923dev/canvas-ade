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

  test('filter narrows rows + shows X / Y count; regex + invert toggles work', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await page.getByRole('button', { name: 'Network inspector' }).click()
    await expect(page.locator('.bb-net-row').first()).toBeVisible({ timeout: 8000 })

    const filterInput = page.getByRole('textbox', { name: 'Filter requests' })

    // A guaranteed-miss query → "No matches" + the filtered "0 / Y requests" count.
    await filterInput.fill('zzzz-no-such-request-zzzz')
    await expect(page.locator('.bb-net-empty')).toContainText('No matches')
    await expect(page.locator('.bb-net-meta')).toContainText('0 /')

    // Clearing restores the rows.
    await filterInput.fill('')
    await expect(page.locator('.bb-net-row').first()).toBeVisible()

    // Invert with an empty filter hides everything (NOT match-all).
    const invertBtn = page.getByRole('button', { name: 'Invert filter' })
    await invertBtn.click()
    await expect(invertBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.bb-net-empty')).toContainText('No matches')
    await invertBtn.click()

    // Regex mode: an invalid pattern flags the filter box red.
    const regexBtn = page.getByRole('button', { name: 'Use regular expression' })
    await regexBtn.click()
    await expect(regexBtn).toHaveAttribute('aria-pressed', 'true')
    await filterInput.fill('(')
    await expect(page.locator('.bb-net-filter-err')).toBeVisible()
  })

  test('details pane: switch tab, then Escape and the X both close it', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await page.getByRole('button', { name: 'Network inspector' }).click()
    const firstRow = page.locator('.bb-net-row').first()
    await expect(firstRow).toBeVisible({ timeout: 8000 })

    await firstRow.click()
    const details = page.locator('.bb-net-details')
    await expect(details).toBeVisible()

    // Switch to the Timing tab → it becomes the active subtab.
    await details.getByRole('button', { name: 'Timing' }).click()
    await expect(details.locator('.bb-net-subtab-on')).toHaveText('Timing')

    // Escape closes the pane.
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)

    // Re-select, then close via the X.
    await firstRow.click()
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: 'Close details' }).click()
    await expect(details).toHaveCount(0)
  })

  test('resource-type pills: plain-click selects one, Ctrl-click multi-selects', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await page.getByRole('button', { name: 'Network inspector' }).click()
    await expect(page.locator('.bb-net-row').first()).toBeVisible({ timeout: 8000 })

    const all = page.getByRole('button', { name: 'All', exact: true })
    const docPill = page.getByRole('button', { name: 'Doc', exact: true })
    const jsPill = page.getByRole('button', { name: 'JS', exact: true })

    // Plain click selects exactly one (All clears).
    await docPill.click()
    await expect(docPill).toHaveAttribute('aria-pressed', 'true')
    await expect(all).toHaveAttribute('aria-pressed', 'false')

    // Ctrl-click adds a second pill to the OR'd set.
    await jsPill.click({ modifiers: ['Control'] })
    await expect(docPill).toHaveAttribute('aria-pressed', 'true')
    await expect(jsPill).toHaveAttribute('aria-pressed', 'true')

    // Plain-clicking All resets to the single default.
    await all.click()
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(docPill).toHaveAttribute('aria-pressed', 'false')
    await expect(jsPill).toHaveAttribute('aria-pressed', 'false')
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

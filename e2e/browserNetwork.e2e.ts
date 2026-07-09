import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import {
  deselectInspector,
  evalIn,
  mainCall,
  openInspectorSection,
  pollEval,
  seed,
  selectForInspector
} from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

/** P5: the URL-bar toggle is gone — open the panel via Inspector › Developer › the Network
 *  inspector switch, then DESELECT so the left-docked Inspector can't occlude clicks on the
 *  panel itself (the board is fitView'd across the whole window). The panel's own chrome
 *  (Close X, dock toggle, tabs) is unchanged. */
async function openNet(page: Page, id: string, opts: { reload?: boolean } = {}): Promise<void> {
  await selectForInspector(page, id)
  await openInspectorSection(page, 'Developer')
  await page.getByRole('switch', { name: 'Network inspector' }).click()
  await deselectInspector(page)
  // H6: network capture is LAZY now — it arms only when this panel subscribes (the switch click
  // above → Network.enable), matching real DevTools ("open the panel, then reload to record"). The
  // page already loaded before the panel opened, so reload WITH the panel open to capture a fresh
  // document load + any ?xhr/?big/?find subresources — giving the assertions below real captured rows.
  // A caller that immediately injects SYNTHETIC rows via seedOsrNet (a reopen replay) passes
  // { reload: false } — the reload's clear-on-nav would otherwise race the seed and blank the list.
  if (opts.reload !== false) {
    await evalIn(page, `window.api.reloadOsrPreview(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)
  }
}

/**
 * @preview — the DevTools Network inspector end-to-end (real OSR instance):
 * open the per-board panel from its Inspector switch, confirm MAIN's always-on capture replays a
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
    await openNet(page, id)
    await expect(page.locator('.bb-net'), 'panel opens on toggle').toBeVisible()

    // MAIN captured the document load always-on; subscribe replays it → at least one row.
    const firstRow = page.locator('.bb-net-row').first()
    await expect(firstRow, 'a captured request row appears').toBeVisible({ timeout: 8000 })

    // The summary footer reports transfer/resource totals.
    await expect(page.locator('.bb-net-summary'), 'summary footer').toContainText('transferred')

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

    await openNet(page, id)
    await expect(page.locator('.bb-net-row').first()).toBeVisible({ timeout: 8000 })

    const filterInput = page.getByRole('textbox', { name: 'Filter requests' })

    // A guaranteed-miss query → "No matches" + the filtered "0 / Y requests" count.
    await filterInput.fill('zzzz-no-such-request-zzzz')
    await expect(page.locator('.bb-net-empty')).toContainText('No matches')
    await expect(page.locator('.bb-net-meta')).toContainText('0 /')

    // Clearing restores the rows.
    await filterInput.fill('')
    await expect(page.locator('.bb-net-row').first()).toBeVisible()

    // Invert is a NO-OP with an EMPTY filter (Chrome parity) — toggling it must NOT blank the list.
    const invertBtn = page.getByRole('button', { name: 'Invert filter' })
    await invertBtn.click()
    await expect(invertBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.locator('.bb-net-row').first(),
      'invert + empty query still shows all rows'
    ).toBeVisible()
    // With a query present, invert flips the match: a guaranteed-miss query inverted → shows rows.
    await filterInput.fill('zzzz-no-such-request-zzzz')
    await expect(
      page.locator('.bb-net-row').first(),
      'inverted miss-query shows rows (flips the empty match-set)'
    ).toBeVisible()
    await filterInput.fill('')
    await invertBtn.click() // toggle invert back off for the regex check

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

    await openNet(page, id)
    const firstRow = page.locator('.bb-net-row').first()
    await expect(firstRow).toBeVisible({ timeout: 8000 })

    await firstRow.click()
    const details = page.locator('.bb-net-details')
    await expect(details).toBeVisible()

    // The Chrome tab set is present (Preview / Initiator / Timing always; Payload/Cookies conditional).
    await expect(details.getByRole('button', { name: 'Preview' })).toBeVisible()
    await expect(details.getByRole('button', { name: 'Initiator' })).toBeVisible()

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

    await openNet(page, id)
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

    await openNet(page, id)
    // Default dock = bottom.
    await expect(page.locator('.bb-net.bb-net-bottom')).toBeVisible()
    // Switch to right.
    await page.getByRole('button', { name: 'Dock to right' }).click()
    await expect(page.locator('.bb-net.bb-net-right')).toBeVisible()
    await expect(page.locator('.bb-net.bb-net-bottom')).toHaveCount(0)
  })

  test('SLICE-010: a 1000-record capture is virtualized — only ~viewport rows mount; scroll + filter still reach every record', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    await expect(page.locator('.bb-net-row').first()).toBeVisible({ timeout: 8000 })

    // Seed 1000 synthetic records (replay REPLACES the few real document-load rows). MAIN's ring
    // cap (MAX_RECORDS=1000) keeps the total at 1000 even if a stray live delta lands.
    await evalIn(page, `window.__canvasE2E.seedOsrNet(${JSON.stringify(id)}, 1000)`)

    // The meta line reports the full 1000-record set …
    await expect(page.locator('.bb-net-meta')).toContainText(/1\d{3} requests/)
    // … but only a viewport-bounded number of <tr>s actually mount (virtualized — not 1000).
    await expect
      .poll(async () => page.locator('.bb-net-row').count(), { timeout: 4000 })
      .toBeLessThan(80)
    expect(await page.locator('.bb-net-row').count(), 'some rows render').toBeGreaterThan(0)

    // The last record sits far below the fold → it is NOT in the DOM initially …
    await expect(page.getByText('req-0999.js', { exact: true })).toHaveCount(0)
    // … scrolling the list to the bottom mounts it (every record is reachable — the invariant).
    await evalIn(
      page,
      `(() => { const el = document.querySelector('.bb-net-list'); if (el) el.scrollTop = el.scrollHeight })()`
    )
    await expect(page.getByText('req-0999.js', { exact: true })).toBeVisible({ timeout: 4000 })

    // Filter still narrows the FULL set (not merely the rendered window): a unique mid-list id.
    const filterInput = page.getByRole('textbox', { name: 'Filter requests' })
    await filterInput.fill('req-0500.js')
    await expect(page.getByText('req-0500.js', { exact: true })).toBeVisible()
    await expect(page.locator('.bb-net-row'), 'filter resolves to the single match').toHaveCount(1)
  })

  // Regression for the PR #219 reviewer [warning]: the panel returns null while closed (the list
  // unmounts) but the virtualization hook stays mounted, so its `scrollTop` state survives. A reopened
  // list mounts FRESH at scrollTop 0 — a stale large `scrollTop` would render a huge top spacer into a
  // top-anchored viewport and the table would look blank until the first scroll. The fix seeds
  // `scrollTop` from the live element on (re)attach.
  test('SLICE-010: reopening after scrolling does not leave a blank table (stale scrollTop reseed)', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    await expect(page.locator('.bb-net-row').first()).toBeVisible({ timeout: 8000 })
    await evalIn(page, `window.__canvasE2E.seedOsrNet(${JSON.stringify(id)}, 1000)`)
    await expect(page.locator('.bb-net-meta')).toContainText(/1\d{3} requests/)

    // Scroll to the bottom so the hook's scrollTop state is large, then close the inspector.
    await evalIn(
      page,
      `(() => { const el = document.querySelector('.bb-net-list'); if (el) el.scrollTop = el.scrollHeight })()`
    )
    await expect(page.getByText('req-0999.js', { exact: true })).toBeVisible({ timeout: 4000 })
    await page.getByRole('button', { name: 'Close inspector' }).click()
    await expect(page.locator('.bb-net')).toHaveCount(0)

    // Reopen. This path re-seeds synthetic rows via seedOsrNet, so skip openNet's reload (its
    // clear-on-nav would race the seed); re-subscribe alone recreates the many-rows condition.
    await openNet(page, id, { reload: false })
    await expect
      .poll(
        async () => {
          await evalIn(page, `window.__canvasE2E.seedOsrNet(${JSON.stringify(id)}, 1000)`)
          return (await page.locator('.bb-net-meta').textContent()) ?? ''
        },
        { timeout: 5000 }
      )
      .toContain('1000')

    // With the seed-on-reattach fix the window is anchored at the top → an early row renders. Without
    // it the window would sit ~row 980 behind a full-viewport top spacer and the table would be blank.
    await expect(
      page.getByText('req-0000.js', { exact: true }),
      'reopened table is not blank — scrollTop was reseeded to the fresh element'
    ).toBeVisible({ timeout: 4000 })
  })

  test('drag the resize handle grows the panel (bottom dock)', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    const panel = page.locator('.bb-net.bb-net-bottom')
    await expect(panel).toBeVisible()
    const handle = page.locator('.bb-net-resize-bottom')
    await expect(handle, 'resize handle present on bottom dock').toBeVisible()

    const before = await panel.boundingBox()
    const hb = await handle.boundingBox()
    if (!before || !hb) throw new Error('panel/handle box unavailable')
    // Drag the divider UP ~70 screen px → the bottom-docked panel grows taller.
    const cx = hb.x + hb.width / 2
    const cy = hb.y + hb.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy - 70, { steps: 6 })
    await page.mouse.up()

    await expect
      .poll(async () => (await panel.boundingBox())?.height ?? 0, { timeout: 3000 })
      .toBeGreaterThan(before.height + 10)
  })

  test('JSON response body renders as a foldable tree (JsonView) + Raw toggle', async ({
    page,
    electronApp
  }) => {
    const base = await mainCall<string>(electronApp, 'localUrl')
    // ?xhr makes the page fetch('/json') as a SUBRESOURCE — its body is loadable over CDP (the main
    // document's body is evicted after navigation commits → "No resource with given identifier found").
    const id = await seed(page, 'browser', { url: `${base}?xhr=1` })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    // Select the JSON fetch row (urlName → "json").
    const row = page.locator('.bb-net-row', { hasText: 'json' }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await row.click()

    const details = page.locator('.bb-net-details')
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: 'Response' }).click()
    await details.getByRole('button', { name: 'Load body' }).click()

    // It renders as a TREE (not a flat <pre>): the big int is shown verbatim from source with a chip,
    // proving the source-string tokenizer path (JSON.parse would have lost precision → 1.2345e19).
    const rows = details.locator('.bb-net-json-rows')
    await expect(rows).toBeVisible({ timeout: 8000 })
    await expect(rows).toContainText('tags')
    await expect(rows).toContainText('12345678901234567890')
    await expect(rows).toContainText('64-bit')

    // Fold the root container → children vanish; unfold → they return.
    const openRow = rows.locator('.bb-net-json-open').first()
    await openRow.click()
    await expect(rows).not.toContainText('tags')
    await openRow.click()
    await expect(rows).toContainText('tags')

    // Click a value → it copies and a transient toast confirms.
    await rows.locator('.bb-net-json-val').first().click()
    await expect(page.locator('.toast-msg', { hasText: 'Copied' })).toBeVisible()

    // Raw mode shows the lossless re-indented source.
    await details.getByRole('button', { name: 'Raw' }).click()
    await expect(details.locator('.bb-net-bodytext')).toContainText('"id": 12345678901234567890')
  })

  test('a 50k-element array opens virtualized — the live DOM holds ≤~50 rows (JD-2)', async ({
    page,
    electronApp
  }) => {
    const base = await mainCall<string>(electronApp, 'localUrl')
    // ?big → the page fetches /json?big=1 (a 50,000-element array) as a loadable subresource.
    const id = await seed(page, 'browser', { url: `${base}?big=1` })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    const row = page.locator('.bb-net-row', { hasText: 'json' }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await row.click()

    const details = page.locator('.bb-net-details')
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: 'Response' }).click()
    await details.getByRole('button', { name: 'Load body' }).click()

    const rows = details.locator('.bb-net-json-rows')
    await expect(rows).toBeVisible({ timeout: 8000 })
    // The huge array starts default-collapsed (childCount ≫ 100) → its 50000 count shows on the summary.
    await expect(rows).toContainText('50000')

    // Expand it: the visible list is now 50k+ rows, but the virtualizer mounts only a windowful.
    await rows.locator('.bb-net-json-open').first().click()
    await expect
      .poll(async () => rows.locator('.bb-net-json-row').count(), { timeout: 5000 })
      .toBeGreaterThan(5) // expanded (no longer just the collapsed root)
    const liveRows = await rows.locator('.bb-net-json-row').count()
    expect(
      liveRows,
      'live DOM rows for a 50k array stay window-bounded (virtualized)'
    ).toBeLessThanOrEqual(50)
  })

  test('in-body search: Ctrl/Cmd+G jumps to a match inside a collapsed subtree (JD-2)', async ({
    page,
    electronApp
  }) => {
    const base = await mainCall<string>(electronApp, 'localUrl')
    // ?find → /json?find=1 = {"a":{"b":{"c":{"needle":"FINDME_DEEP"}}}} — the match sits at depth 4,
    // inside default-collapsed (depth ≥ 2) containers, so it is hidden until the search auto-expands.
    const id = await seed(page, 'browser', { url: `${base}?find=1` })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    const row = page.locator('.bb-net-row', { hasText: 'json' }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await row.click()

    const details = page.locator('.bb-net-details')
    await details.getByRole('button', { name: 'Response' }).click()
    await details.getByRole('button', { name: 'Load body' }).click()

    const rows = details.locator('.bb-net-json-rows')
    await expect(rows).toBeVisible({ timeout: 8000 })
    // The deep match is inside a collapsed subtree → not in the visible tree yet.
    await expect(rows).not.toContainText('FINDME_DEEP')

    // Open the find bar, type a query, then Ctrl+G → step to the match (auto-expanding its ancestors).
    await details.getByRole('button', { name: 'Find in body' }).click()
    await details.getByRole('searchbox', { name: 'Find in body' }).fill('FINDME')
    await page.keyboard.press('Control+g')

    await expect(rows).toContainText('FINDME_DEEP')
    await expect(details.locator('.bb-net-json-match.current')).toBeVisible()
  })

  test('Data Flow tab: body-free inventory, opt-in gate, then VALUE-LESS inferred schema (JD-3)', async ({
    page,
    electronApp
  }) => {
    const base = await mainCall<string>(electronApp, 'localUrl')
    // ?xhr → the page fetches /json as a SUBRESOURCE so its response body is loadable over CDP for
    // sampling (the main-document body is evicted post-commit — same gotcha as the JsonView test).
    const id = await seed(page, 'browser', { url: `${base}?xhr=1` })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await pollEval(page, runtimeStatus(id, 'connected'), 10_000)

    await openNet(page, id)
    await expect(page.locator('.bb-net-row').first()).toBeVisible({ timeout: 8000 })

    // Switch to the Data Flow tab → the body-free inventory renders immediately.
    await page.getByRole('button', { name: 'Data Flow' }).click()
    const jsonRow = page.locator('.bb-net-df-row', { hasText: 'json' }).first()
    await expect(jsonRow, 'the /json route appears as a body-free inventory row').toBeVisible({
      timeout: 8000
    })

    // Expand it while bodies are OFF → the opt-in gate, NOT a schema (zero body reads yet).
    await jsonRow.click()
    await expect(page.locator('.bb-net-df-gate')).toBeVisible()
    await expect(page.locator('.bb-net-df-gate')).toContainText('Shapes are off')

    // Enable inference → MAIN samples the /json body and returns a VALUE-LESS skeleton.
    await page.getByRole('button', { name: 'Enable' }).click()
    const fields = page.locator('.bb-net-df-fields').first()
    await expect(fields, 'the inferred schema renders').toBeVisible({ timeout: 8000 })
    await expect(fields).toContainText('id')
    await expect(fields).toContainText('name')
    await expect(fields).toContainText('tags')
    // the response is fully deconstructed — the nested object is expanded inline, not summarized.
    await expect(fields).toContainText('nested')
    // shape, NOT values: the captured value "e2e" (name) must never appear in the rendered schema.
    await expect(fields).not.toContainText('e2e')
    // an always-present field is marked required (single sample → every field required).
    await expect(fields).toContainText('required')
  })
})

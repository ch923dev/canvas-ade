import { test, expect } from './fixtures'
import { evalIn, pollEval, seed, selectForInspector } from './helpers'

/**
 * @preview Data-Flow board (JD-4) — drives the REAL board with a canned login→home capture seeded
 * through the stores (`seedDataFlowDemo`), then asserts the focus-defaulted graph renders entities +
 * endpoints + a dashed id-lineage edge, and that "→ Planning" materializes a Mermaid diagram element.
 * Also writes a screenshot artifact for the visual dev check.
 */
test.describe('@preview Data-Flow board (JD-4)', () => {
  test('renders a focus-defaulted graph (entities + dashed id-lineage) and exports to Planning', async ({
    page
  }) => {
    const src = await seed(page, 'browser', {})
    const df = await evalIn<string>(
      page,
      `window.__canvasE2E.seedBoard('dataflow', { sourceBoardId: ${JSON.stringify(src)} })`
    )
    await evalIn(page, `window.__canvasE2E.setBoardSize(${JSON.stringify(df)}, 940, 600)`)
    await evalIn(
      page,
      `window.__canvasE2E.seedDataFlowDemo(${JSON.stringify(src)}, ${JSON.stringify(df)})`
    )
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(df)})`)

    const node = page.locator(`.react-flow__node[data-id="${df}"]`)
    // the graph backbone renders through the SHARED spec renderer (Phase 5): at least one
    // endpoint (service) node + one inferred entity (data) node
    await expect(node.locator('.pl-spec-node[data-kind="service"]').first()).toBeVisible({
      timeout: 5000
    })
    await expect(node.locator('.pl-spec-node[data-kind="data"]').first()).toBeVisible()
    // the id-lineage edge (the JD-4 flagship) — dependency-dash + active (accent) status
    const lineage = node.locator('g.pl-spec-edge[data-kind="dependency"][data-status="active"]')
    await expect(lineage.first()).toBeAttached()
    // two-engine token pin (REVIEW risk 7): the lineage stroke must derive from --accent and a
    // neutral data node's fill from --surface-raised — Data-Flow-via-spec respects the tokens.
    expect(await lineage.first().locator('path').getAttribute('stroke')).toMatch(/79,\s*140,\s*255/)
    const dataFill = await node
      .locator('.pl-spec-node[data-kind="data"][data-status="neutral"]')
      .first()
      .evaluate((el) => (globalThis as any).getComputedStyle(el).backgroundColor as string)
    expect(dataFill).toBe('rgb(26, 26, 29)')
    // focus-on-node default dims part of the surface (some node is not bright)
    expect(await node.locator('.pl-spec-node.pl-spec-dim').count()).toBeGreaterThan(0)
    // clicking empty canvas CLEARS focus past the default (the Phase-5 unfocus fix): everything
    // brightens and the legend flips to "full surface"
    await node.locator('.df-specstage').click({ position: { x: 4, y: 4 } })
    await expect.poll(() => node.locator('.pl-spec-node.pl-spec-dim').count()).toBe(0)
    await expect(node.locator('.df-legend-meta')).toContainText('full surface')
    // visual dev-check artifact
    await node.screenshot({ path: 'test-results/jd4-dataflow-board.png' })

    // P5: the filter/hidden roll-up + the actions moved into the Board Inspector — select to reveal.
    // The default noise filter hid the non-API `document` record (API-only default exercised) →
    // Inspector › Filters shows the "Hidden" meta.
    await selectForInspector(page, df)
    const hiddenShown = await pollEval(
      page,
      `(document.querySelector('[data-test="board-inspector"]')?.textContent || '').includes('Hidden')`,
      5000
    )
    expect(hiddenShown, 'the API-only default surfaces the Hidden meta in the Inspector').toBe(true)

    // "→ Planning" materializes an editable Mermaid erDiagram element on a new Planning board
    const before = await evalIn<number>(
      page,
      `window.__canvasE2E.getBoards().filter(b => b.type === 'planning').length`
    )
    await page.locator('[data-test="inspector-dataflow-planning"]').click()
    await expect
      .poll(async () =>
        evalIn<number>(
          page,
          `window.__canvasE2E.getBoards().filter(b => b.type === 'planning').length`
        )
      )
      .toBe(before + 1)
    const hasErd = await evalIn<boolean>(
      page,
      `window.__canvasE2E.getBoards().some(b => b.type === 'planning' && (b.elements||[]).some(e => e.kind === 'diagram' && /erDiagram/.test(e.source)))`
    )
    expect(hasErd).toBe(true)
  })

  test('a flat API draws zero entity→entity / lineage edges (graceful degradation)', async ({
    page
  }) => {
    // Pin the browser origin to the SAME host the seeded rows live on (`example.test`). The flat set
    // we assert on must be deterministic, but a real Browser board's OSR window also live-captures its
    // own page load (e.g. a running dev server on localhost) — those asset URLs carry `?v=`/`?t=` query
    // ids and `/…/{id}/…` paths, which `urlSideLineage` would legitimately turn into edges and pollute
    // the "flat" assertion (a timing-dependent flake). Keeping the first-party filter ON (with the
    // origin = example.test) excludes that cross-origin noise, so only the 6 seeded rows are graphed.
    const src = await seed(page, 'browser', { url: 'https://example.test/' })
    const df = await evalIn<string>(
      page,
      `window.__canvasE2E.seedBoard('dataflow', { sourceBoardId: ${JSON.stringify(src)} })`
    )
    // a flat capture: 6 unrelated endpoints, no shared ids — via the generic seeder (all /req-*.js)
    await evalIn(page, `window.__canvasE2E.seedOsrNet(${JSON.stringify(src)}, 6)`)
    // apiOnly OFF so the `.js` asset rows show; first-party ON so only example.test (the seeds) is graphed.
    await evalIn(page, `window.__canvasE2E.setDfFilters(${JSON.stringify(df)}, false, true)`)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(df)})`)
    const node = page.locator(`.react-flow__node[data-id="${df}"]`)
    await expect(node.locator('.pl-spec-node[data-kind="service"]').first()).toBeVisible({
      timeout: 5000
    })
    // rel AND lineage both map to dependency-kind edges — a flat API draws none of either
    expect(await node.locator('g.pl-spec-edge[data-kind="dependency"]').count()).toBe(0)
  })

  test('noise filters are on by default and hide non-API records (toggleable)', async ({
    page
  }) => {
    const src = await seed(page, 'browser', {})
    const df = await evalIn<string>(
      page,
      `window.__canvasE2E.seedBoard('dataflow', { sourceBoardId: ${JSON.stringify(src)} })`
    )
    await evalIn(
      page,
      `window.__canvasE2E.seedDataFlowDemo(${JSON.stringify(src)}, ${JSON.stringify(df)})`
    )
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(df)})`)
    const node = page.locator(`.react-flow__node[data-id="${df}"]`)
    await expect(node.locator('.pl-spec-node[data-kind="service"]').first()).toBeVisible({
      timeout: 5000
    })
    // P5: the "hidden N" roll-up lives in the Inspector's Filters section — select to reveal.
    // Default API-only filter hides the non-API `document` record → the Hidden meta is shown.
    await selectForInspector(page, df)
    const hiddenShown = await pollEval(
      page,
      `(document.querySelector('[data-test="board-inspector"]')?.textContent || '').includes('Hidden')`,
      5000
    )
    expect(hiddenShown, 'API-only default surfaces the Hidden meta').toBe(true)
    // turn API-only off (first-party still on, all records are localhost) → nothing hidden → meta gone
    await evalIn(page, `window.__canvasE2E.setDfFilters(${JSON.stringify(df)}, false, true)`)
    const hiddenGone = await pollEval(
      page,
      `!((document.querySelector('[data-test="board-inspector"]')?.textContent || '').includes('Hidden'))`,
      5000
    )
    expect(hiddenGone, 'clearing the filter removes the Hidden meta').toBe(true)
  })
})

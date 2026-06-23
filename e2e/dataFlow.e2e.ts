import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'

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
    // the graph backbone: at least one endpoint card + one inferred entity card
    await expect(node.locator('.df-gn-endpoint').first()).toBeVisible({ timeout: 5000 })
    await expect(node.locator('.df-gn-entity').first()).toBeVisible()
    // the dashed id-lineage edge (the JD-4 flagship)
    await expect(node.locator('.df-e-lin').first()).toBeAttached()
    // focus-on-node default dims part of the surface (some node is not bright)
    expect(await node.locator('.df-gn.df-dim').count()).toBeGreaterThan(0)
    // the default noise filter hid the non-API `document` record (API-only default exercised)
    await expect(node.locator('.df-hidden')).toBeVisible()

    // visual dev-check artifact
    await node.screenshot({ path: 'test-results/jd4-dataflow-board.png' })

    // "→ Planning" materializes an editable Mermaid erDiagram element on a new Planning board
    const before = await evalIn<number>(
      page,
      `window.__canvasE2E.getBoards().filter(b => b.type === 'planning').length`
    )
    await node.getByText('→ Planning').click()
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
    await expect(node.locator('.df-gn-endpoint').first()).toBeVisible({ timeout: 5000 })
    expect(await node.locator('.df-e-rel').count()).toBe(0)
    expect(await node.locator('.df-e-lin').count()).toBe(0)
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
    // default API-only filter hides the non-API `document` record → the "hidden N" chip is shown
    await expect(node.locator('.df-hidden')).toBeVisible({ timeout: 5000 })
    // turn API-only off (first-party still on, all records are localhost) → nothing hidden → chip gone
    await evalIn(page, `window.__canvasE2E.setDfFilters(${JSON.stringify(df)}, false, true)`)
    await expect(node.locator('.df-hidden')).toHaveCount(0)
  })
})

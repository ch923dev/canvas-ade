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
    const src = await seed(page, 'browser', {})
    const df = await evalIn<string>(
      page,
      `window.__canvasE2E.seedBoard('dataflow', { sourceBoardId: ${JSON.stringify(src)} })`
    )
    // a flat capture: unrelated endpoints, no shared ids — via the generic seeder (all /req-*.js)
    await evalIn(page, `window.__canvasE2E.seedOsrNet(${JSON.stringify(src)}, 6)`)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(df)})`)
    const node = page.locator(`.react-flow__node[data-id="${df}"]`)
    await expect(node.locator('.df-gn-endpoint').first()).toBeVisible({ timeout: 5000 })
    expect(await node.locator('.df-e-rel').count()).toBe(0)
    expect(await node.locator('.df-e-lin').count()).toBe(0)
  })
})

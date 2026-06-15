import { test, expect } from './fixtures'
import { mainCall, seed } from './helpers'

/**
 * @core PR-3 read-only app self-model (app-side), against the REAL running app.
 *
 * `describeApp` assembles the app self-model — board-type capabilities, the MCP tool catalog
 * (name/purpose/tier), the LIVE canvas (boards/connectors/groups), and the orchestration rules —
 * via the orchestrator, read-only. The `@expanse-ade/mcp` package exposes no `canvas://app-model`
 * resource yet (PR-3b), so this drives the same app-side path in-process via the CANVAS_E2E
 * `__canvasE2EMain.describeApp` seam.
 *
 * The base `page` fixture resets the canvas before each test, so boards never leak between them.
 */

interface AppModelShape {
  version: number
  boardTypes: Array<{ type: string; seedable: boolean; autowire: string | null }>
  tools: Array<{ name: string; tier: string }>
  canvas: { boards: Array<{ id: string; type: string }>; connectors: unknown[]; groups: unknown[] }
  rules: { spawnCap: number; everyWriteGated: boolean }
}

test.describe('@core describeApp (read-only app self-model via the app-side seam)', () => {
  test('returns the static capability model: board types, tool tiers, gated-write rule', async ({
    electronApp
  }) => {
    const m = await mainCall<AppModelShape | null>(electronApp, 'describeApp')
    expect(m, 'describeApp should resolve a model (MCP server mounted)').not.toBeNull()
    const model = m as AppModelShape
    expect(model.version).toBe(1)
    expect(model.boardTypes.map((t) => t.type)).toEqual(['terminal', 'browser', 'planning'])
    // worker-tier is EXACTLY ping + write_result; everything else is orchestrator-tier
    const worker = model.tools
      .filter((t) => t.tier === 'worker')
      .map((t) => t.name)
      .sort()
    expect(worker).toEqual(['ping', 'write_result'])
    expect(model.rules.spawnCap).toBe(4)
    expect(model.rules.everyWriteGated).toBe(true)
    // groups stay [] until PR-5 mirrors Named Groups to MAIN
    expect(model.canvas.groups).toEqual([])
  })

  test('reflects a seeded board in the live canvas', async ({ page, electronApp }) => {
    const id = await seed(page, 'planning')
    // The board appears once the renderer->MAIN mirror (mcp:boards, ~150ms debounce) carries it.
    await expect
      .poll(
        async () => {
          const m = await mainCall<AppModelShape | null>(electronApp, 'describeApp')
          return m?.canvas.boards.some((b) => b.id === id) ?? false
        },
        { timeout: 8_000 }
      )
      .toBe(true)
  })
})

import { test, expect } from './fixtures'
import { evalIn, mainCall } from './helpers'

/**
 * @core PR-5b `spawnGroup` write primitive, against the REAL running app.
 *
 * `spawnGroup` is the first GROUP-level write path: MAIN mints every id, reserves the cluster's
 * slots against the spawn cap, and drives ONE `sendCommand({type:'spawnGroup'})` round-trip; the
 * renderer creates the boards (terminal + optional planning/browser) + a Named Group over them +
 * the browser→terminal preview wiring, in one undoable step. The `@expanse-ade/mcp` package
 * exposes no `spawn_group` MCP tool yet (PR-5c), so this drives the same orchestrator path
 * in-process via the CANVAS_E2E `__canvasE2EMain.spawnGroupNow` seam — the same cap-checked
 * `orchestrator.spawnGroup` the future tool will call.
 *
 * The base `page` fixture resets the canvas before each test, so zones never leak between them.
 */

interface SpawnGroupResult {
  groupId: string
  terminalId: string
  planningId?: string
  browserId?: string
}

interface AppModelShape {
  canvas: { groups: Array<{ id: string; name: string; boardIds: string[] }> }
}

interface RendererGroup {
  id: string
  name: string
  boardIds: string[]
}

test.describe('@core spawnGroup (feature-zone cluster via the app-side seam)', () => {
  test('spawns a full {terminal, planning, browser} zone — boards, group + preview wiring all land', async ({
    page,
    electronApp
  }) => {
    const res = await mainCall<SpawnGroupResult | null>(electronApp, 'spawnGroupNow', {
      name: 'Auth zone',
      planning: true,
      browser: true
    })
    expect(res, 'spawnGroupNow should resolve ids (MCP server mounted)').not.toBeNull()
    const { groupId, terminalId, planningId, browserId } = res as SpawnGroupResult
    expect(planningId).toBeTruthy()
    expect(browserId).toBeTruthy()

    // (a) Renderer truth: the group exists over exactly the three minted boards.
    await expect
      .poll(
        async () => {
          const groups = await evalIn<RendererGroup[]>(page, `window.__canvasE2E.getGroups()`)
          const g = groups.find((x) => x.id === groupId)
          return g ? [...g.boardIds].sort().join(',') : null
        },
        { timeout: 8_000 }
      )
      .toBe([terminalId, planningId, browserId].sort().join(','))

    // (b) The browser member is wired to the terminal (previewSourceId — the preview-edge SoT).
    const wiredSource = await evalIn<string | undefined>(
      page,
      `window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(browserId)})?.previewSourceId`
    )
    expect(wiredSource).toBe(terminalId)

    // (c) MAIN mirror: the app self-model's live `canvas.groups` carries the zone (renderer→MAIN
    //     mcp:boards mirror, ~150ms debounce).
    await expect
      .poll(
        async () => {
          const m = await mainCall<AppModelShape | null>(electronApp, 'describeApp')
          const g = m?.canvas.groups.find((x) => x.id === groupId)
          return g ? `${g.name}|${g.boardIds.length}` : null
        },
        { timeout: 8_000 }
      )
      .toBe('Auth zone|3')
  })

  test('spawns a terminal-only zone when planning/browser are omitted', async ({
    page,
    electronApp
  }) => {
    const res = await mainCall<SpawnGroupResult | null>(electronApp, 'spawnGroupNow', {
      name: 'Solo zone'
    })
    const { groupId, terminalId, planningId, browserId } = res as SpawnGroupResult
    expect(planningId).toBeUndefined()
    expect(browserId).toBeUndefined()
    await expect
      .poll(
        async () => {
          const groups = await evalIn<RendererGroup[]>(page, `window.__canvasE2E.getGroups()`)
          return groups.find((x) => x.id === groupId)?.boardIds ?? null
        },
        { timeout: 8_000 }
      )
      .toEqual([terminalId])
  })
})

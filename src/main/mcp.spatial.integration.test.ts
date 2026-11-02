/**
 * Spatial surface over the real wire, per tier (`@expanse-ade/mcp` 0.27.0, SPEC C6 / D1).
 *
 * Two classes this pins, both invisible to tsc and to the package's own MockOrchestrator drift guard:
 *
 * 1. MEMBERSHIP (the C6 🔒 `publish_findings` lesson): the package registers a spatial surface only
 *    when the HOST orchestrator implements its method, so a forgotten forward makes a tool vanish
 *    silently. tools/list + resources/list against `buildOrchestrator` is the only place that shows.
 * 2. THE D1 GATE: 0.27 hands `tidy_canvas` / `focus_viewport` to lead + connected terminals and binds
 *    their `sourceBoardId`; the host must turn that into ONE human confirm. A host that ignored the
 *    field would type-check (method params are bivariant) and let any consented terminal repack the
 *    canvas or move the camera unasked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import {
  expectTools,
  startMcpToolsHarness,
  type McpTier,
  type McpToolsHarness
} from './mcpToolsHarness'

const SPATIAL_TOOLS = ['tidy_canvas', 'focus_viewport']
/** Registered by the package only when the host implements groupBoards / editGroups (I1). */
const GROUP_TOOLS = ['group_boards', 'edit_groups']
const LAYOUT_URI = 'canvas://layout'
/** Registered only when the host implements describeContexts (I1). */
const CONTEXTS_URI = 'canvas://contexts'
/** The package's one-shot warning when a host method is missing (C6 lock) — must never fire now. */
const SKIPPED_WARN = /is NOT registered: the host Orchestrator does not implement/
// The package dedups that warning in MODULE scope (once per surface per process), so it fires on the
// FIRST server build in this file. Spy from file load, before any harness exists, or it is missed.
const warnSpy = vi.spyOn(console, 'warn')
afterAll(() => warnSpy.mockRestore())

/** The structured error code the package's tool boundary puts on a failed result. */
function errorCode(r: unknown): string | undefined {
  return (r as { structuredContent?: { error?: { code?: string } } })?.structuredContent?.error
    ?.code
}

describe('spatial tools/list + resources membership per tier (real host orchestrator)', () => {
  let h: McpToolsHarness

  beforeAll(async () => {
    h = await startMcpToolsHarness()
  })

  afterAll(async () => {
    await h?.close()
  })

  for (const planningWrite of [false, true]) {
    it(`🔒 tidy/focus + group tools: orchestrator + lead + connected have them, worker never (planningWrite ${planningWrite})`, async () => {
      const byTier = await h.toolsByTier({ planningWrite })
      for (const tier of ['orchestrator', 'lead', 'connected'] as McpTier[]) {
        expectTools(byTier[tier], { present: [...SPATIAL_TOOLS, ...GROUP_TOOLS] }, tier)
      }
      expectTools(
        byTier.worker,
        { present: ['ping'], absent: [...SPATIAL_TOOLS, ...GROUP_TOOLS] },
        'worker'
      )
    })
  }

  it('🔒 canvas://layout + canvas://contexts reach orchestrator + lead + connected, never a worker', async () => {
    for (const tier of ['orchestrator', 'lead', 'connected', 'worker'] as McpTier[]) {
      const s = await h.connect(tier)
      try {
        const uris = (await s.client.listResources()).resources.map((r) => r.uri)
        expect(uris.includes(LAYOUT_URI), `${tier} ${LAYOUT_URI}`).toBe(tier !== 'worker')
        expect(uris.includes(CONTEXTS_URI), `${tier} ${CONTEXTS_URI}`).toBe(tier !== 'worker')
      } finally {
        await s.close()
      }
    }
  })

  it('🔒 the package "is NOT registered" warning never fired for this host', () => {
    // Every tier above has built a server by now (the membership tests run first).
    const skipped = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => SKIPPED_WARN.test(m))
    expect(skipped).toEqual([])
  })
})

describe('tidy_canvas / focus_viewport D1 gate over the wire', () => {
  const sent: McpCommand[] = []
  let approve = true
  const confirm = vi.fn(async () => ({ approved: approve }))
  const sendCommand = async (cmd: McpCommand): Promise<McpCommandAck> => {
    sent.push(cmd)
    return { ok: true, type: cmd.type, ...(cmd.type === 'tidyBoards' ? { moved: 2 } : {}) }
  }
  let h: McpToolsHarness

  beforeAll(async () => {
    h = await startMcpToolsHarness({ registry: { confirm, sendCommand } })
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(() => {
    sent.length = 0
    confirm.mockClear()
    approve = true
  })

  async function call(tier: McpTier, name: string, args: Record<string, unknown>) {
    const s = await h.connect(tier)
    try {
      return await s.client.callTool({ name, arguments: args })
    } finally {
      await s.close()
    }
  }

  it('orchestrator tier: tidy + focus apply with NO confirm', async () => {
    const tidy = await call('orchestrator', 'tidy_canvas', { mode: 'grid' })
    expect(tidy.isError).toBeFalsy()
    const focus = await call('orchestrator', 'focus_viewport', { boardId: 't2' })
    expect(focus.isError).toBeFalsy()
    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toEqual([
      { type: 'tidyBoards', mode: 'grid' },
      { type: 'focusCamera', boardId: 't2' }
    ])
  })

  for (const tier of ['lead', 'connected'] as McpTier[]) {
    it(`${tier} tier APPROVED: one confirm per call, naming the caller's board, then it applies`, async () => {
      const tidy = await call(tier, 'tidy_canvas', {})
      expect(tidy.isError).toBeFalsy()
      expect(tidy.content).toEqual([{ type: 'text', text: JSON.stringify({ moved: 2 }) }])
      const focus = await call(tier, 'focus_viewport', { boardId: 't2' })
      expect(focus.isError).toBeFalsy()
      expect(confirm).toHaveBeenCalledTimes(2)
      // The bound board (t1, "Worker 1") is named — the binding is the token's, not client input.
      for (const [req] of confirm.mock.calls as unknown as Array<[{ body: string }]>) {
        expect(req.body).toContain('"Worker 1"')
      }
      // D8 (a): the omitted mode reaches the renderer as an IMPLICIT roles (the package never defaults it).
      expect(sent).toEqual([
        { type: 'tidyBoards', mode: 'roles', implicit: true },
        { type: 'focusCamera', boardId: 't2' }
      ])
    })

    it(`🔒 ${tier} tier DENIED: a "declined" error and nothing reaches the renderer`, async () => {
      approve = false
      const tidy = await call(tier, 'tidy_canvas', { mode: 'smart' })
      const focus = await call(tier, 'focus_viewport', {})
      for (const r of [tidy, focus]) {
        expect(r.isError).toBe(true)
        expect(errorCode(r)).toBe('declined')
      }
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(sent).toEqual([])
    })
  }

  it('a host-invalid tidy is invalid_input over the wire — before any confirm', async () => {
    // The wire accepts overflow with any mode; the host rejects pages for a legacy packer (it
    // cannot page) rather than silently dropping it — and asks no human first.
    const r = await call('connected', 'tidy_canvas', { mode: 'smart', overflow: 'pages' })
    expect(r.isError).toBe(true)
    expect(errorCode(r)).toBe('invalid_input')
    expect(JSON.stringify(r.content)).toMatch(/applies to mode fit \/ roles only/)
    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('every 0.27 field reaches the renderer: fit / roles / tile over the wire (orchestrator)', async () => {
    for (const args of [
      { mode: 'fit', overflow: 'shrink', fit: false, scope: 'visible' },
      { mode: 'roles', primary: 't2', resize: false },
      { mode: 'tile', template: 'cols-3', scope: { groupId: 'g1' } }
    ]) {
      const r = await call('orchestrator', 'tidy_canvas', args)
      expect(r.isError).toBeFalsy()
    }
    expect(sent).toEqual([
      { type: 'tidyBoards', mode: 'fit', overflow: 'shrink', fit: false, scope: 'visible' },
      { type: 'tidyBoards', mode: 'roles', primary: 't2', resize: false },
      { type: 'tidyBoards', mode: 'tile', template: 'cols-3', scope: { groupId: 'g1' } }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  buildSwarmToolDefs,
  composeRoleLaunch,
  executeSwarmTool,
  SWARM_AUTO_ALLOW,
  type SwarmCanvasFacet,
  type SwarmRunCtx,
  type SwarmRunEvent
} from './swarmTools'
import { ROLE_PACKS, rolePackById } from '../shared/rolePacks'

const facetStub = (over: Partial<SwarmCanvasFacet> = {}): SwarmCanvasFacet => ({
  describeApp: vi.fn(async () => ({
    version: 1 as const,
    boardTypes: [],
    tools: [],
    canvas: {
      boards: [{ id: 't1', type: 'terminal', title: 'W', status: 'running' }] as never,
      connectors: [],
      groups: []
    },
    rules: {} as never
  })),
  spawnBoard: vi.fn(async () => ({ id: 'spawned-1' })),
  dispatchPrompt: vi.fn(async () => ({ delivery: 'ready' as const })),
  awaitSettled: vi.fn(async () => ({ status: 'done', summary: 'ok', synthesized: true })),
  visualizePlan: vi.fn(async () => ({ id: 'plan-1' })),
  ...over
})

const ctxStub = (over: Partial<SwarmRunCtx> = {}): SwarmRunCtx & { events: SwarmRunEvent[] } => {
  const events: SwarmRunEvent[] = []
  return {
    paused: () => false,
    writeInFlight: new Set<string>(),
    workerRoles: new Map<string, string>(),
    emit: (ev) => events.push(ev),
    confirm: vi.fn(async () => ({ approved: true })),
    events,
    ...over
  }
}

describe('composeRoleLaunch — role pack → claude launch line', () => {
  it('builder gets skip-permissions; read-only packs get plan mode', () => {
    const builder = rolePackById('builder')!
    const reviewer = rolePackById('code-reviewer')!
    expect(composeRoleLaunch(builder)).toContain('--dangerously-skip-permissions')
    expect(composeRoleLaunch(builder)).toContain('claude --model')
    expect(composeRoleLaunch(reviewer)).toContain('--permission-mode plan')
  })

  it('stays under the 400-char MAIN spawn clamp for every shipped pack', () => {
    for (const p of ROLE_PACKS) expect(composeRoleLaunch(p).length).toBeLessThan(400)
  })
})

describe('executeSwarmTool', () => {
  it('list_workers reduces the app model to id/type/title/status (auto-allowed)', async () => {
    expect(SWARM_AUTO_ALLOW.has('list_workers')).toBe(true)
    const out = await executeSwarmTool('list_workers', {}, facetStub(), ctxStub())
    expect(JSON.parse(out.content)).toEqual([
      { id: 't1', type: 'terminal', title: 'W', status: 'running' }
    ])
  })

  it('draw_plan validates items, calls visualizePlan(checklist), and emits planDrawn', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    const out = await executeSwarmTool(
      'draw_plan',
      { title: 'Run', items: [{ title: 'recon' }, { title: 'migrate', status: 'doing' }] },
      facet,
      ctx
    )
    expect(out.isError).toBeUndefined()
    expect(facet.visualizePlan).toHaveBeenCalledWith(
      expect.objectContaining({ suggested: 'checklist', title: 'Run' })
    )
    expect(ctx.events).toEqual([{ kind: 'planDrawn', planBoardId: 'plan-1' }])
  })

  it('spawn_worker pays the human confirm; a denial spawns nothing', async () => {
    const facet = facetStub()
    const ctx = ctxStub({ confirm: vi.fn(async () => ({ approved: false })) })
    const out = await executeSwarmTool(
      'spawn_worker',
      { name: 'builder-1', role: 'builder' },
      facet,
      ctx
    )
    expect(out.denied).toBe(true)
    expect(facet.spawnBoard).not.toHaveBeenCalled()
  })

  it('spawn_worker (approved) spawns a terminal with the role launch, records the role, emits', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    const out = await executeSwarmTool(
      'spawn_worker',
      { name: 'builder-1', role: 'builder' },
      facet,
      ctx
    )
    expect(JSON.parse(out.content)).toEqual({ workerId: 'spawned-1' })
    expect(facet.spawnBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'terminal',
        title: 'builder-1',
        prompt: expect.stringContaining('claude')
      })
    )
    expect(ctx.workerRoles.get('spawned-1')).toBe('builder')
    expect(ctx.events[0]).toMatchObject({ kind: 'workerSpawned', workerId: 'spawned-1' })
  })

  it('spawn_worker rejects an unknown role naming the catalog', async () => {
    const out = await executeSwarmTool(
      'spawn_worker',
      { name: 'x', role: 'wizard' },
      facetStub(),
      ctxStub()
    )
    expect(out.isError).toBe(true)
    expect(out.content).toContain('builder')
  })

  it('dispatch_task requires ALL four fields', async () => {
    const out = await executeSwarmTool(
      'dispatch_task',
      { workerId: 'w', objective: 'do it', context: 'ctx', boundaries: 'none' }, // no outputFormat
      facetStub(),
      ctxStub()
    )
    expect(out.isError).toBe(true)
    expect(out.content).toContain('outputFormat')
  })

  it('dispatch_task prepends the role brief and carries the four-field spec', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    ctx.workerRoles.set('w1', 'code-reviewer')
    await executeSwarmTool(
      'dispatch_task',
      { workerId: 'w1', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
      facet,
      ctx
    )
    const sent = (facet.dispatchPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(sent).toContain(rolePackById('code-reviewer')!.systemPrompt.slice(0, 40))
    expect(sent).toContain('OBJECTIVE: o')
    expect(sent).toContain('BOUNDARIES: b')
  })

  it('write serialization: a second un-settled write-role dispatch is refused, disclosed; await frees the slot', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    ctx.workerRoles.set('w1', 'builder')
    ctx.workerRoles.set('w2', 'builder')
    const four = { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' }
    const first = await executeSwarmTool('dispatch_task', { workerId: 'w1', ...four }, facet, ctx)
    expect(first.isError).toBeUndefined()
    const second = await executeSwarmTool('dispatch_task', { workerId: 'w2', ...four }, facet, ctx)
    expect(second.isError).toBe(true)
    expect(second.content).toContain('write cap')
    expect(second.content).toContain('disclose')
    // Settle w1 → the slot frees → w2 dispatches.
    await executeSwarmTool('await_worker', { workerId: 'w1' }, facet, ctx)
    const third = await executeSwarmTool('dispatch_task', { workerId: 'w2', ...four }, facet, ctx)
    expect(third.isError).toBeUndefined()
  })

  it('await_worker returns provenance (synthesized ⇒ synthesized, else claimed) + emits settled', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    const out = await executeSwarmTool('await_worker', { workerId: 'w1' }, facet, ctx)
    expect(JSON.parse(out.content).provenance).toBe('synthesized')
    expect(ctx.events[0]).toMatchObject({ kind: 'workerSettled', provenance: 'synthesized' })
    const claimed = await executeSwarmTool(
      'await_worker',
      { workerId: 'w2' },
      facetStub({ awaitSettled: vi.fn(async () => ({ status: 'done', summary: 's' })) }),
      ctxStub()
    )
    expect(JSON.parse(claimed.content).provenance).toBe('claimed')
  })

  it('paused run: every mutating tool refuses; reads still work', async () => {
    const facet = facetStub()
    const ctx = ctxStub({ paused: () => true })
    for (const [name, input] of [
      ['draw_plan', { title: 't', items: [{ title: 'x' }] }],
      ['spawn_worker', { name: 'n', role: 'builder' }],
      [
        'dispatch_task',
        { workerId: 'w', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' }
      ]
    ] as const) {
      const out = await executeSwarmTool(name, input, facet, ctx)
      expect(out.isError).toBe(true)
      expect(out.content).toContain('paused')
    }
    const read = await executeSwarmTool('list_workers', {}, facet, ctx)
    expect(read.isError).toBeUndefined()
  })

  it('tool defs: dispatch_task declares the four fields required; spawn_worker enumerates roles', () => {
    const defs = buildSwarmToolDefs()
    const dispatch = defs.find((d) => d.name === 'dispatch_task')!
    expect(dispatch.input_schema.required).toEqual([
      'workerId',
      'objective',
      'context',
      'boundaries',
      'outputFormat'
    ])
    const spawn = defs.find((d) => d.name === 'spawn_worker')!
    const roleProp = (spawn.input_schema.properties as Record<string, { enum?: string[] }>).role
    expect(roleProp.enum).toEqual(ROLE_PACKS.map((p) => p.id))
  })
})

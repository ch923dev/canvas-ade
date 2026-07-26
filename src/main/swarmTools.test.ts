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
import { sanitizeDispatchText } from './dispatchSanitize'

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
  boardPlanning: vi.fn(async () => ({ elements: [] })),
  updatePlanningElement: vi.fn(async () => {}),
  dispatchPrompts: vi.fn(async (items: Array<{ boardId: string; text: string }>) =>
    items.map((it) => ({
      boardId: it.boardId,
      status: 'dispatched' as const,
      delivery: 'ready' as const
    }))
  ),
  ...over
})

const ctxStub = (over: Partial<SwarmRunCtx> = {}): SwarmRunCtx & { events: SwarmRunEvent[] } => {
  const events: SwarmRunEvent[] = []
  return {
    paused: () => false,
    writeInFlight: new Set<string>(),
    workerRoles: new Map<string, string>(),
    planBoard: { current: null },
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

  it('model override wins over the pack tier; absent ⇒ tier alias', () => {
    const builder = rolePackById('builder')!
    expect(composeRoleLaunch(builder)).toContain('--model sonnet')
    expect(composeRoleLaunch(builder, 'opus')).toContain('--model opus')
    expect(composeRoleLaunch(builder, 'opus')).not.toContain('sonnet')
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

  it('dispatch_tasks sends the whole round through ONE batch call and records each landed row', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    ctx.workerRoles.set('w1', 'builder')
    ctx.workerRoles.set('w2', 'code-reviewer')
    const ledger = { planDrawn: vi.fn(), dispatched: vi.fn(), settled: vi.fn() }
    const out = await executeSwarmTool(
      'dispatch_tasks',
      {
        tasks: [
          {
            workerId: 'w1',
            objective: 'o1',
            context: 'c',
            boundaries: 'b',
            outputFormat: 'f',
            activity: 'Doing one…',
            planItem: 1
          },
          { workerId: 'w2', objective: 'o2', context: 'c', boundaries: 'b', outputFormat: 'f' }
        ]
      },
      facet,
      { ...ctx, ledger }
    )
    expect(out.isError).toBeUndefined()
    expect(facet.dispatchPrompts).toHaveBeenCalledTimes(1) // ONE modal, not two
    const sent = (facet.dispatchPrompts as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as Array<{ boardId: string; text: string }>
    expect(sent.map((r) => r.boardId)).toEqual(['w1', 'w2'])
    expect(sent.every((r) => !r.text.includes('\n') && !r.text.includes('\r'))).toBe(true) // one approval = one line
    expect(out.summary).toContain('dispatched 2/2')
    expect(ledger.dispatched).toHaveBeenCalledTimes(2)
    expect(ctx.events).toContainEqual({ kind: 'activity', workerId: 'w1', text: 'Doing one…' })
  })

  it('dispatch_tasks names the declined + failed rows in the summary (statusline shows summary only)', async () => {
    const facet = facetStub({
      dispatchPrompts: vi.fn(async () => [
        { boardId: 'w1', status: 'dispatched' as const, delivery: 'ready' as const },
        { boardId: 'w2', status: 'denied' as const, detail: 'declined by the human gate' },
        { boardId: 'w3', status: 'rejected' as const, detail: 'target vanished during confirm' }
      ])
    })
    const ctx = ctxStub()
    const task = (id: string): Record<string, unknown> => ({
      workerId: id,
      objective: 'o',
      context: 'c',
      boundaries: 'b',
      outputFormat: 'f'
    })
    const out = await executeSwarmTool(
      'dispatch_tasks',
      { tasks: [task('w1'), task('w2'), task('w3')] },
      facet,
      ctx
    )
    expect(out.summary).toContain('dispatched 1/3')
    expect(out.summary).toContain('1 declined')
    expect(out.summary).toContain('target vanished')
  })

  it('dispatch_tasks refuses the WHOLE round rather than half-validating it', async () => {
    const facet = facetStub()
    const out = await executeSwarmTool(
      'dispatch_tasks',
      {
        tasks: [
          { workerId: 'w1', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
          { workerId: 'w2', objective: 'o' }
        ]
      },
      facet,
      ctxStub()
    )
    expect(out.isError).toBe(true)
    expect(facet.dispatchPrompts).not.toHaveBeenCalled()
  })

  it('dispatch_tasks refuses a round that would exceed the write cap, and NAMES the cap', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    ctx.workerRoles.set('w1', 'builder')
    ctx.workerRoles.set('w2', 'builder')
    const task = (id: string): Record<string, unknown> => ({
      workerId: id,
      objective: 'o',
      context: 'c',
      boundaries: 'b',
      outputFormat: 'f'
    })
    const out = await executeSwarmTool(
      'dispatch_tasks',
      { tasks: [task('w1'), task('w2')] },
      facet,
      ctx
    )
    expect(out.isError).toBe(true)
    expect(out.content).toContain('write cap')
    expect(out.content).toContain('working tree')
    expect(facet.dispatchPrompts).not.toHaveBeenCalled()
    expect(ctx.writeInFlight.size).toBe(0) // nothing reserved by a refused round
  })

  it('dispatch_tasks releases the write slot of a row the human declined', async () => {
    const facet = facetStub({
      dispatchPrompts: vi.fn(async () => [{ boardId: 'w1', status: 'denied' as const }])
    })
    const ctx = ctxStub()
    ctx.workerRoles.set('w1', 'builder')
    await executeSwarmTool(
      'dispatch_tasks',
      {
        tasks: [
          { workerId: 'w1', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' }
        ]
      },
      facet,
      ctx
    )
    expect(ctx.writeInFlight.size).toBe(0)
  })

  it('draw_plan records the plan board so tick_plan_item can find it later', async () => {
    const facet = facetStub()
    const ctx = ctxStub()
    await executeSwarmTool('draw_plan', { title: 'Run', items: [{ title: 'recon' }] }, facet, ctx)
    expect(ctx.planBoard.current).toBe('plan-1')
  })

  it('tick_plan_item resolves the position against the LIVE board and pays the edit gate', async () => {
    const facet = facetStub({
      boardPlanning: vi.fn(async () => ({
        elements: [
          {
            id: 'cl-1',
            kind: 'checklist',
            items: [
              { id: 'i1', label: 'recon', done: false },
              { id: 'i2', label: 'migrate', done: false }
            ]
          }
        ]
      }))
    })
    const ctx = ctxStub({ planBoard: { current: 'plan-1' } })
    const out = await executeSwarmTool('tick_plan_item', { planItem: 2 }, facet, ctx)
    expect(out.isError).toBeUndefined()
    // The REAL item id, read back from the board — MAIN never mints plan-item ids.
    expect(facet.updatePlanningElement).toHaveBeenCalledWith('plan-1', 'cl-1', {
      setItems: [{ id: 'i2', done: true }]
    })
  })

  it('tick_plan_item refuses with no plan, a bad position, or a position past the end', async () => {
    const facet = facetStub({
      boardPlanning: vi.fn(async () => ({
        elements: [
          { id: 'cl-1', kind: 'checklist', items: [{ id: 'i1', label: 'a', done: false }] }
        ]
      }))
    })
    const noPlan = await executeSwarmTool('tick_plan_item', { planItem: 1 }, facet, ctxStub())
    expect(noPlan.isError).toBe(true)
    expect(noPlan.content).toContain('draw_plan')

    const ctx = ctxStub({ planBoard: { current: 'plan-1' } })
    for (const bad of [0, -1, 2.5, 'x']) {
      const out = await executeSwarmTool('tick_plan_item', { planItem: bad }, facet, ctx)
      expect(out.isError).toBe(true)
    }
    const past = await executeSwarmTool('tick_plan_item', { planItem: 9 }, facet, ctx)
    expect(past.isError).toBe(true)
    expect(facet.updatePlanningElement).not.toHaveBeenCalled()
  })

  it('tick_plan_item is a no-op (no confirm burned) when the item is already in that state', async () => {
    const facet = facetStub({
      boardPlanning: vi.fn(async () => ({
        elements: [{ id: 'cl-1', kind: 'checklist', items: [{ id: 'i1', label: 'a', done: true }] }]
      }))
    })
    const ctx = ctxStub({ planBoard: { current: 'plan-1' } })
    const out = await executeSwarmTool('tick_plan_item', { planItem: 1 }, facet, ctx)
    expect(out.isError).toBeUndefined()
    expect(out.content).toContain('"changed":false')
    expect(facet.updatePlanningElement).not.toHaveBeenCalled()
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

  it('spawn_worker confirm carries workerConfig; the dialog commit sets launch + role', async () => {
    const facet = facetStub()
    // The human commits an edited launch + a different role in the worker-config dialog.
    const ctx = ctxStub({
      confirm: vi.fn(async () => ({
        approved: true,
        launchCommand: 'claude --model opus --dangerously-skip-permissions',
        rolePackId: 'code-reviewer'
      }))
    })
    await executeSwarmTool(
      'spawn_worker',
      { name: 'w', role: 'builder', model: 'opus' },
      facet,
      ctx
    )
    const req = (ctx.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(req.workerConfig).toMatchObject({
      workerName: 'w',
      roleId: 'builder',
      modelDefault: 'opus'
    })
    expect(req.workerConfig.defaultLaunch).toContain('--model opus')
    expect(facet.spawnBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'claude --model opus --dangerously-skip-permissions'
      })
    )
    // The committed role (not the requested one) is what the dispatch bookkeeping records.
    expect(ctx.workerRoles.get('spawned-1')).toBe('code-reviewer')
  })

  it('spawn_worker openRouter commit rides the spawn; absent commit stays direct', async () => {
    const facet = facetStub()
    const ctx = ctxStub({
      confirm: vi.fn(async () => ({
        approved: true,
        openRouter: { enabled: true, model: 'anthropic/claude-sonnet-4.5' }
      }))
    })
    await executeSwarmTool('spawn_worker', { name: 'w', role: 'builder' }, facet, ctx)
    expect(facet.spawnBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        openRouter: { enabled: true, model: 'anthropic/claude-sonnet-4.5' }
      })
    )
    // No intent on the reply → no field on the spawn (a direct worker).
    const facet2 = facetStub()
    await executeSwarmTool('spawn_worker', { name: 'w', role: 'builder' }, facet2, ctxStub())
    const arg = (facet2.spawnBoard as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.openRouter).toBeUndefined()
  })

  it('🔒 spawn_worker refuses a malformed openRouter commit (whitespace/control slug, forged enabled) — never silently stripped', async () => {
    for (const openRouter of [
      { enabled: true, model: 'evil slug' }, // whitespace = not one token
      { enabled: true, model: 'x'.repeat(201) }, // over the clamp
      { enabled: true, model: 'a' + String.fromCharCode(7) + 'b' }, // control char (sanitize would strip => off-contract)
      { enabled: false, model: 'anthropic/claude-sonnet-4.5' } // forged: only enabled=true rides
    ]) {
      const facet = facetStub()
      const out = await executeSwarmTool(
        'spawn_worker',
        { name: 'w', role: 'builder' },
        facet,
        ctxStub({ confirm: vi.fn(async () => ({ approved: true, openRouter })) })
      )
      expect(out.isError).toBe(true)
      expect(out.content).toMatch(/OpenRouter model/)
      expect(facet.spawnBoard).not.toHaveBeenCalled()
    }
  })

  it('spawn_worker commit validation: multi-line/oversize launch refuses; absent commit approves the default; junk role falls back', async () => {
    // 🔒 The reply proposes, MAIN disposes: an off-contract launch line REFUSES (never silently
    // fixed), an approve without a commit approves exactly the defaultLaunch the body showed,
    // and an unknown rolePackId falls back to the requested pack.
    const multiline = await executeSwarmTool(
      'spawn_worker',
      { name: 'w', role: 'builder' },
      facetStub(),
      ctxStub({
        confirm: vi.fn(async () => ({ approved: true, launchCommand: 'claude\nrm -rf /' }))
      })
    )
    expect(multiline.isError).toBe(true)
    expect(multiline.content).toContain('one non-empty line')
    const oversize = await executeSwarmTool(
      'spawn_worker',
      { name: 'w', role: 'builder' },
      facetStub(),
      ctxStub({
        confirm: vi.fn(async () => ({ approved: true, launchCommand: 'x'.repeat(401) }))
      })
    )
    expect(oversize.isError).toBe(true)
    const facet = facetStub()
    const ctx = ctxStub({
      confirm: vi.fn(async () => ({ approved: true, rolePackId: 'not-a-pack' }))
    })
    await executeSwarmTool('spawn_worker', { name: 'w', role: 'builder' }, facet, ctx)
    expect(facet.spawnBoard).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('--model sonnet') })
    )
    expect(ctx.workerRoles.get('spawned-1')).toBe('builder')
  })

  it('spawn_worker honors a closed-vocabulary model override; junk model is refused', async () => {
    const facet = facetStub()
    await executeSwarmTool(
      'spawn_worker',
      { name: 'builder-opus', role: 'builder', model: 'opus' },
      facet,
      ctxStub()
    )
    expect(facet.spawnBoard).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('--model opus') })
    )
    // The value splices into the launch line — anything off-whitelist must refuse, never pass.
    const bad = await executeSwarmTool(
      'spawn_worker',
      { name: 'x', role: 'builder', model: 'opus; rm -rf /' },
      facetStub(),
      ctxStub()
    )
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('haiku, sonnet, opus')
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

  it('dispatch_task payload is a SINGLE line (the write gate rejects embedded CR/LF)', async () => {
    // The S1 eyeball bug: the four-field spec + role brief are multi-line by construction, and
    // the shared dispatch sanitizer REJECTS any embedded newline BEFORE the human confirm —
    // every dispatch died with no dialog. The executor must collapse via singleLinePrompt.
    const facet = facetStub()
    const ctx = ctxStub()
    ctx.workerRoles.set('w1', 'builder')
    await executeSwarmTool(
      'dispatch_task',
      { workerId: 'w1', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
      facet,
      ctx
    )
    const sent = (facet.dispatchPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(sent).not.toMatch(/[\r\n]/)
    expect(() => sanitizeDispatchText(sent)).not.toThrow()
  })

  it('dispatch_task failure surfaces the REASON in the summary (the chat statusline)', async () => {
    const facet = facetStub({
      dispatchPrompt: vi.fn(async () => {
        throw new Error('assign_prompt: board not found: w9')
      })
    })
    const out = await executeSwarmTool(
      'dispatch_task',
      { workerId: 'w9', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
      facet,
      ctxStub()
    )
    expect(out.isError).toBe(true)
    expect(out.summary).toContain('board not found')
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
      ],
      ['tick_plan_item', { planItem: 1 }],
      [
        'dispatch_tasks',
        {
          tasks: [
            { workerId: 'w', objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' }
          ]
        }
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

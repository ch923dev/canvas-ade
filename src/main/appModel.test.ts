import { describe, it, expect } from 'vitest'
import { buildAppModel, APP_TOOLS, APP_BOARD_TYPES, type AppModelInputs } from './appModel'

const baseInputs = (over?: Partial<AppModelInputs>): AppModelInputs => ({
  boards: [],
  connectors: [],
  rules: { spawnCap: 4, everyWriteGated: true, idleTtlMs: 300_000, idleActivityMs: 60_000 },
  ...over
})

describe('buildAppModel (PR-3 app self-model)', () => {
  it('stamps version 1 and includes the static board-type + tool tables', () => {
    const m = buildAppModel(baseInputs())
    expect(m.version).toBe(1)
    expect(m.boardTypes.map((t) => t.type)).toEqual(['terminal', 'browser', 'planning'])
    expect(m.tools).toHaveLength(APP_TOOLS.length)
  })

  it('classifies ONLY ping + write_result as worker-tier; everything else orchestrator', () => {
    const m = buildAppModel(baseInputs())
    const worker = m.tools
      .filter((t) => t.tier === 'worker')
      .map((t) => t.name)
      .sort()
    expect(worker).toEqual(['ping', 'write_result'])
    expect(m.tools.every((t) => t.tier === 'orchestrator' || t.tier === 'worker')).toBe(true)
  })

  it('describes board-type capabilities (seedable / autowire)', () => {
    const m = buildAppModel(baseInputs())
    const byType = Object.fromEntries(m.boardTypes.map((t) => [t.type, t]))
    expect(byType.browser.autowire).toBe('port-detect->preview')
    expect(byType.terminal.autowire).toBeNull()
    expect(byType.terminal.seedable).toBe(true)
    expect(byType.browser.seedable).toBe(false)
    expect(byType.planning.seedable).toBe(true)
  })

  it('every per-board-type tool references a tool in the global catalog', () => {
    const catalog = new Set(APP_TOOLS.map((t) => t.name))
    for (const bt of APP_BOARD_TYPES) {
      for (const name of bt.tools) expect(catalog.has(name)).toBe(true)
    }
  })

  it('passes through live boards + connectors, defaulting groups to []', () => {
    const boards = [{ id: 'b1', type: 'terminal', title: 'T', status: 'running' }]
    const connectors = [{ id: 'c1', sourceId: 'b1', targetId: 'b2', kind: 'orchestration' }]
    const m = buildAppModel(baseInputs({ boards, connectors }))
    expect(m.canvas.boards).toEqual(boards)
    expect(m.canvas.connectors).toEqual(connectors)
    expect(m.canvas.groups).toEqual([])
  })

  it('passes through groups when provided (PR-5 forward-compat)', () => {
    const groups = [{ id: 'g1', name: 'Auth', boardIds: ['b1', 'b2'] }]
    const m = buildAppModel(baseInputs({ groups }))
    expect(m.canvas.groups).toEqual(groups)
  })

  it('carries the rules budget + the every-write-gated invariant', () => {
    const m = buildAppModel(
      baseInputs({ rules: { spawnCap: 7, everyWriteGated: true, idleTtlMs: 1, idleActivityMs: 2 } })
    )
    expect(m.rules.spawnCap).toBe(7)
    expect(m.rules.everyWriteGated).toBe(true)
  })

  it('returns fresh table copies (does not alias the module-level static tables)', () => {
    const m = buildAppModel(baseInputs())
    expect(m.tools).not.toBe(APP_TOOLS)
    expect(m.boardTypes).not.toBe(APP_BOARD_TYPES)
    m.boardTypes[0].tools.push('MUTANT')
    expect(APP_BOARD_TYPES[0].tools).not.toContain('MUTANT')
  })
})

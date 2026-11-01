import { describe, it, expect } from 'vitest'
import {
  toolErrorCodeOf,
  type BoardOutput,
  type BoardResult,
  type MemoryDoc
} from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import { jarvisTidyInput } from './mcpTidy'
import type { McpCommand, McpCommandAck } from './mcpCommand'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

interface Harness {
  registry: BoardRegistry
  sent: McpCommand[]
  confirms: Array<{ title: string; body: string }>
}

/**
 * A registry whose `sendCommand` records the command and returns a `tidyBoards` ack carrying a
 * configurable `moved` count — so the test proves tidyCanvas forwards the right command AND surfaces
 * the applier's moved count. `confirm` records every request and answers `approve` (the D1 gate).
 */
function harness(
  opts: {
    moved?: number
    ackOk?: boolean
    approve?: boolean
    ack?: Record<string, unknown>
  } = {}
): Harness {
  const sent: McpCommand[] = []
  const confirms: Array<{ title: string; body: string }> = []
  const ackOk = opts.ackOk ?? true
  const registry: BoardRegistry = {
    listBoards: () => [
      { id: 'lead-1', type: 'terminal', title: 'Lead agent', status: 'idle' },
      { id: 'web-1', type: 'browser', title: 'App', status: 'idle' },
      { id: 'swarm-1', type: 'swarm', title: 'Swarm', status: 'idle' },
      { id: 'dock-1', type: 'terminal', title: 'Worker', status: 'idle', dockedIn: 'swarm-1' }
    ],
    listSessions: () => [],
    listConnectors: () => [],
    readOutput: () => EMPTY_OUTPUT,
    readResult: () => EMPTY_RESULT,
    readMemory: () => EMPTY_MEMORY,
    readSummary: () => EMPTY_MEMORY,
    drainPty: async () => {},
    writeToPty: () => true,
    recordResult: () => {},
    subscribeStatus: () => () => {},
    sendCommand: async (cmd): Promise<McpCommandAck> => {
      sent.push(cmd)
      if (!ackOk) return { ok: false, error: 'renderer rejected' }
      if (opts.ack) return { ok: true, type: cmd.type, ...opts.ack } as McpCommandAck
      return {
        ok: true,
        type: cmd.type,
        ...(opts.moved !== undefined ? { moved: opts.moved } : {})
      }
    },
    confirm: async (req) => {
      confirms.push(req)
      return { approved: opts.approve ?? true }
    },
    audit: async () => {}
  }
  return { registry, sent, confirms }
}

describe('orchestrator tidyCanvas (P2)', () => {
  it('forwards a tidyBoards command with the chosen mode and returns the moved count', async () => {
    const h = harness({ moved: 3 })
    const orch = buildOrchestrator(h.registry)
    const result = await orch.tidyCanvas({ mode: 'grid' })
    expect(result).toEqual({ moved: 3 })
    expect(h.sent).toEqual([{ type: 'tidyBoards', mode: 'grid' }])
  })

  it('D8 (a): an OMITTED mode is an implicit roles — mode roles + implicit:true', async () => {
    const h = harness({ moved: 0 })
    const orch = buildOrchestrator(h.registry)
    const result = await orch.tidyCanvas({})
    expect(result).toEqual({ moved: 0 })
    expect(h.sent).toEqual([{ type: 'tidyBoards', mode: 'roles', implicit: true }])
  })

  it('an EXPLICIT mode roles is never implicit (it never falls back)', async () => {
    const h = harness({ moved: 0 })
    await buildOrchestrator(h.registry).tidyCanvas({ mode: 'roles' })
    expect(h.sent).toEqual([{ type: 'tidyBoards', mode: 'roles' }])
  })

  it('defaults moved to 0 when the ack carries no count', async () => {
    const h = harness({}) // ack has no `moved`
    const orch = buildOrchestrator(h.registry)
    expect(await orch.tidyCanvas({ mode: 'smart' })).toEqual({ moved: 0 })
  })

  it('throws when the renderer rejects the apply', async () => {
    const h = harness({ ackOk: false })
    const orch = buildOrchestrator(h.registry)
    await expect(orch.tidyCanvas({ mode: 'by-type' })).rejects.toThrow(/tidy_canvas failed/)
  })
})

describe('tidy_canvas D1 gate (lead / connected ⇒ one human confirm)', () => {
  it('orchestrator tier (no sourceBoardId) stays UN-GATED — no confirm, the tidy applies', async () => {
    const h = harness({ moved: 2 })
    const orch = buildOrchestrator(h.registry)
    expect(await orch.tidyCanvas({ mode: 'smart' })).toEqual({ moved: 2 })
    expect(h.confirms).toHaveLength(0)
    expect(h.sent).toEqual([{ type: 'tidyBoards', mode: 'smart' }])
  })

  it('a lead/connected caller APPROVED: ONE confirm naming the caller, then ONE tidyBoards', async () => {
    const h = harness({ moved: 4, approve: true })
    const orch = buildOrchestrator(h.registry)
    expect(await orch.tidyCanvas({ mode: 'grid', sourceBoardId: 'lead-1' })).toEqual({ moved: 4 })
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].title).toMatch(/tidy/i)
    expect(h.confirms[0].body).toContain('"Lead agent"')
    expect(h.sent).toEqual([{ type: 'tidyBoards', mode: 'grid' }])
  })

  it('🔒 DENIED: a `declined` tool error and NOTHING is sent to the renderer', async () => {
    const h = harness({ approve: false })
    const orch = buildOrchestrator(h.registry)
    const err = await orch.tidyCanvas({ sourceBoardId: 'lead-1' }).catch((e: unknown) => e)
    expect(toolErrorCodeOf(err)).toBe('declined')
    expect(h.confirms).toHaveLength(1)
    expect(h.sent).toHaveLength(0)
  })

  it('🔒 an EMPTY sourceBoardId still gates (fail closed), with a generic caller label', async () => {
    const h = harness({ approve: false })
    const orch = buildOrchestrator(h.registry)
    const err = await orch.tidyCanvas({ sourceBoardId: '' }).catch((e: unknown) => e)
    expect(toolErrorCodeOf(err)).toBe('declined')
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].body).toContain('A terminal agent')
    expect(h.sent).toHaveLength(0)
  })
})

describe('tidy_canvas forwards the whole C5 wire (I2)', () => {
  const forwarded: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      'fit + overflow + fit:false',
      { mode: 'fit', overflow: 'pages', fit: false },
      { mode: 'fit', overflow: 'pages', fit: false }
    ],
    [
      'roles + primary + resize + scope',
      { mode: 'roles', primary: 'web-1', resize: false, scope: 'visible' },
      { mode: 'roles', primary: 'web-1', resize: false, scope: 'visible' }
    ],
    [
      'implicit roles + primary',
      { primary: 'web-1' },
      { mode: 'roles', implicit: true, primary: 'web-1' }
    ],
    [
      'tile + template',
      { mode: 'tile', template: 'main-sidebar' },
      { mode: 'tile', template: 'main-sidebar' }
    ],
    [
      'smart + group scope',
      { mode: 'smart', scope: { groupId: 'g-1' } },
      { mode: 'smart', scope: { groupId: 'g-1' } }
    ],
    [
      'overflow report with a legacy packer',
      { mode: 'grid', overflow: 'report' },
      { mode: 'grid', overflow: 'report' }
    ],
    ['fit:true', { fit: true }, { mode: 'roles', implicit: true, fit: true }]
  ]
  for (const [label, input, cmd] of forwarded) {
    it(`${label} ⇒ ONE tidyBoards carrying exactly those fields`, async () => {
      const h = harness({ moved: 1 })
      await buildOrchestrator(h.registry).tidyCanvas(input)
      expect(h.sent).toEqual([{ type: 'tidyBoards', ...cmd }])
    })
  }

  it('returns the C6 facts, sanitized: finite numbers, bounded units, junk dropped', async () => {
    const h = harness({
      ack: {
        moved: 3,
        fitZoom: 0.4567,
        readable: true,
        pages: 2,
        units: [
          { scene: 'lead', heroIds: ['lead-1', 7], why: 'hero = lead', extra: 'x' },
          { scene: 3, heroIds: [], why: 'bad scene' },
          'junk'
        ],
        stray: 'never forwarded'
      }
    })
    const result = await buildOrchestrator(h.registry).tidyCanvas({ mode: 'roles' })
    expect(result).toEqual({
      moved: 3,
      fitZoom: 0.457,
      readable: true,
      pages: 2,
      units: [{ scene: 'lead', heroIds: ['lead-1'], why: 'hero = lead' }]
    })
  })

  it('a non-finite fitZoom / a single page / a negative moved never reach the agent', async () => {
    const h = harness({ ack: { moved: -2, fitZoom: Number.NaN, pages: 1, readable: 'yes' } })
    expect(await buildOrchestrator(h.registry).tidyCanvas({ mode: 'fit' })).toEqual({ moved: 0 })
  })

  it('the W5 confirm is honest about sizes: roles may resize, fit never does', async () => {
    const h = harness({ moved: 1 })
    const orch = buildOrchestrator(h.registry)
    await orch.tidyCanvas({ sourceBoardId: 'lead-1' })
    await orch.tidyCanvas({ mode: 'fit', sourceBoardId: 'lead-1' })
    expect(h.confirms[0].body).toMatch(/by role/)
    expect(h.confirms[0].body).toMatch(/may be resized/)
    expect(h.confirms[0].body).toMatch(/planning, kanban and file boards keep their size/)
    expect(h.confirms[1].body).toMatch(/fit your screen/)
    expect(h.confirms[1].body).toMatch(/nothing is created, resized or deleted/)
  })
})

describe('tidy_canvas validates EVERYTHING before the D1 confirm (invalid_input, nothing sent)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['an off-enum mode', { mode: 'spiral' }],
    ['tile without a template', { mode: 'tile' }],
    ['a template without tile', { mode: 'fit', template: 'cols-3' }],
    ['an unknown template', { mode: 'tile', template: 'cols-9' }],
    ['primary with an explicit non-roles mode', { mode: 'fit', primary: 'web-1' }],
    ['resize with an explicit non-roles mode', { mode: 'smart', resize: false }],
    ['overflow pages with a legacy packer', { mode: 'grid', overflow: 'pages' }],
    ['overflow shrink with tile', { mode: 'tile', template: 'grid', overflow: 'shrink' }],
    ['an unknown overflow', { mode: 'fit', overflow: 'scroll' }],
    ['a malformed scope', { scope: 'everything' }],
    ['a scope with two keys', { scope: { groupId: 'g', boardIds: ['web-1'] } }],
    ['a non-boolean fit', { fit: 'yes' }],
    ['an unknown primary board', { primary: 'ghost' }],
    ['a DOCKED primary board', { primary: 'dock-1' }]
  ]
  for (const [label, input] of cases) {
    it(`${label} ⇒ invalid_input, no confirm, no command`, async () => {
      const h = harness()
      const err = await buildOrchestrator(h.registry)
        .tidyCanvas({ ...input, sourceBoardId: 'lead-1' })
        .catch((e: unknown) => e)
      expect(toolErrorCodeOf(err)).toBe('invalid_input')
      expect(h.confirms).toHaveLength(0) // rejected BEFORE the human is asked
      expect(h.sent).toHaveLength(0)
    })
  }

  it('a { boardIds } scope (Jarvis-only) drops unknown + docked ids; an emptied scope is a no-op', async () => {
    const h = harness({ moved: 1 })
    const orch = buildOrchestrator(h.registry)
    await orch.tidyCanvas({ scope: { boardIds: ['web-1', 'ghost', 'dock-1'] } })
    expect(h.sent).toEqual([
      { type: 'tidyBoards', mode: 'roles', implicit: true, scope: { boardIds: ['web-1'] } }
    ])
    expect(await orch.tidyCanvas({ scope: { boardIds: ['ghost', 'dock-1'] } })).toEqual({
      moved: 0
    })
    expect(h.sent).toHaveLength(1)
  })
})

describe('jarvisTidyInput (C7 amendment — the Jarvis facet)', () => {
  const boards = [
    { id: 'web-1', type: 'browser', title: 'App' },
    { id: 't-1', type: 'terminal', title: 'api' },
    { id: 'dock-1', type: 'terminal', title: 'Worker', dockedIn: 'swarm-1' }
  ]

  it('no args ⇒ the implicit roles default over the whole canvas (no mode, no scope)', () => {
    expect(jarvisTidyInput({}, boards)).toEqual({})
  })

  it('keeps a live primary; drops an unknown or docked one', () => {
    expect(jarvisTidyInput({ primary: 'web-1' }, boards)).toEqual({ primary: 'web-1' })
    expect(jarvisTidyInput({ primary: 'ghost' }, boards)).toEqual({})
    expect(jarvisTidyInput({ primary: 'dock-1' }, boards)).toEqual({})
  })

  it('boardIds ⇒ a { boardIds } scope of the live ids; the primary joins it; empty ⇒ null (no-op)', () => {
    expect(jarvisTidyInput({ boardIds: ['t-1', 'ghost', 'dock-1', 't-1'] }, boards)).toEqual({
      scope: { boardIds: ['t-1'] }
    })
    expect(jarvisTidyInput({ primary: 'web-1', boardIds: ['t-1'] }, boards)).toEqual({
      primary: 'web-1',
      scope: { boardIds: ['t-1', 'web-1'] }
    })
    expect(jarvisTidyInput({ boardIds: ['ghost', 'dock-1'] }, boards)).toBeNull()
    expect(jarvisTidyInput({ boardIds: [] }, boards)).toBeNull()
  })
})

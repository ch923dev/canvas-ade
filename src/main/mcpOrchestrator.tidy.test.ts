import { describe, it, expect } from 'vitest'
import {
  toolErrorCodeOf,
  type BoardOutput,
  type BoardResult,
  type MemoryDoc
} from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
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
function harness(opts: { moved?: number; ackOk?: boolean; approve?: boolean } = {}): Harness {
  const sent: McpCommand[] = []
  const confirms: Array<{ title: string; body: string }> = []
  const ackOk = opts.ackOk ?? true
  const registry: BoardRegistry = {
    listBoards: () => [{ id: 'lead-1', type: 'terminal', title: 'Lead agent', status: 'idle' }],
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
      return ackOk
        ? { ok: true, type: cmd.type, ...(opts.moved !== undefined ? { moved: opts.moved } : {}) }
        : { ok: false, error: 'renderer rejected' }
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

  it('omits mode when none is supplied (renderer applier defaults to smart; D8 a lands with I2)', async () => {
    const h = harness({ moved: 0 })
    const orch = buildOrchestrator(h.registry)
    const result = await orch.tidyCanvas({})
    expect(result).toEqual({ moved: 0 })
    expect(h.sent).toEqual([{ type: 'tidyBoards' }])
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

describe('tidy_canvas rejects input this app version cannot apply (no silent degrade)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['mode fit', { mode: 'fit' }],
    ['mode roles', { mode: 'roles' }],
    ['mode tile', { mode: 'tile', template: 'cols-2' }],
    ['scope', { scope: 'visible' }],
    ['scope group', { scope: { groupId: 'g-1' } }],
    ['template', { template: 'cols-3' }],
    ['overflow', { overflow: 'pages' }],
    ['primary', { primary: 'lead-1' }],
    ['resize', { resize: false }],
    ['fit:false', { fit: false }]
  ]
  for (const [label, input] of cases) {
    it(`${label} ⇒ invalid_input "not supported by this app version yet", no confirm, no command`, async () => {
      const h = harness()
      const orch = buildOrchestrator(h.registry)
      const err = await orch
        .tidyCanvas({ ...input, sourceBoardId: 'lead-1' })
        .catch((e: unknown) => e)
      expect(toolErrorCodeOf(err)).toBe('invalid_input')
      expect((err as Error).message).toMatch(/not supported by this app version yet/)
      expect(h.confirms).toHaveLength(0) // rejected BEFORE the human is asked
      expect(h.sent).toHaveLength(0)
    })
  }

  it('an off-enum mode is invalid_input too (no longer coerced to smart downstream)', async () => {
    const h = harness()
    const orch = buildOrchestrator(h.registry)
    const err = await orch.tidyCanvas({ mode: 'spiral' }).catch((e: unknown) => e)
    expect(toolErrorCodeOf(err)).toBe('invalid_input')
    expect(h.sent).toHaveLength(0)
  })

  it('fit:true matches today (the applier always reframes), so it is accepted', async () => {
    const h = harness({ moved: 1 })
    const orch = buildOrchestrator(h.registry)
    expect(await orch.tidyCanvas({ fit: true })).toEqual({ moved: 1 })
    expect(h.sent).toEqual([{ type: 'tidyBoards' }])
  })
})

import { describe, it, expect } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import type { McpCommand, McpCommandAck } from './mcpCommand'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

interface Harness {
  registry: BoardRegistry
  sent: McpCommand[]
}

/**
 * A registry whose `sendCommand` records the command and returns a `tidyBoards` ack carrying a
 * configurable `moved` count — so the test proves tidyCanvas forwards the right command AND surfaces
 * the applier's moved count. `tidy_canvas` is un-gated (no confirm/audit), so those seams stay no-op.
 */
function harness(opts: { moved?: number; ackOk?: boolean } = {}): Harness {
  const sent: McpCommand[] = []
  const ackOk = opts.ackOk ?? true
  const registry: BoardRegistry = {
    listBoards: () => [],
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
    confirm: async () => ({ approved: true }),
    audit: async () => {}
  }
  return { registry, sent }
}

describe('orchestrator tidyCanvas (P2)', () => {
  it('forwards a tidyBoards command with the chosen mode and returns the moved count', async () => {
    const h = harness({ moved: 3 })
    const orch = buildOrchestrator(h.registry)
    const result = await orch.tidyCanvas({ mode: 'grid' })
    expect(result).toEqual({ moved: 3 })
    expect(h.sent).toEqual([{ type: 'tidyBoards', mode: 'grid' }])
  })

  it('omits mode when none is supplied (renderer applier defaults to smart)', async () => {
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

import { describe, it, expect } from 'vitest'
import { buildOrchestrator } from './mcpOrchestrator'
import type { BoardRegistry } from './mcpRegistry'
import type { AuditInput } from './auditLog'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import type { ConfirmBatchDecision, ConfirmBatchRequest } from './mcpConfirm'

// dispatchPrompts is the BATCH sibling of dispatchPrompt (orchestration S2, design D7): validate
// every row up front (terminal + sanitize), raise ONE per-row confirm modal, then run each valid
// row through the SAME shared write gate independently — own nonce, own BUG-021 TOCTOU re-check,
// own audit — with the human's per-row decision fed in through the gate's confirmOverride seam.
// The batch must never widen ONE approval into N writes; that is what these tests pin.

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

type Board = { id: string; type: string; title: string; status?: string }

function reg(opts: {
  boards: Board[]
  confirmBatch?: (req: ConfirmBatchRequest) => Promise<ConfirmBatchDecision>
  writeToPty?: (id: string, text: string) => boolean
}): {
  registry: BoardRegistry
  audits: AuditInput[]
  writes: Array<{ id: string; text: string }>
  /** Target ids in write order, with the gate's separate `
` terminator write folded out. */
  written: () => string[]
  batches: ConfirmBatchRequest[]
  singles: number
} {
  const audits: AuditInput[] = []
  const writes: Array<{ id: string; text: string }> = []
  const batches: ConfirmBatchRequest[] = []
  const counters = { singles: 0 }
  const registry: BoardRegistry = {
    listBoards: () => opts.boards,
    listConnectors: () => [],
    listSessions: () => [],
    subscribeStatus: () => () => {},
    readOutput: () => EMPTY_OUTPUT,
    readResult: () => EMPTY_RESULT,
    readMemory: () => EMPTY_MEMORY,
    readSummary: () => EMPTY_MEMORY,
    sendCommand: async (cmd) => ({ ok: true, type: cmd.type }),
    drainPty: async () => {},
    writeToPty: (id, text) => {
      writes.push({ id, text })
      return opts.writeToPty ? opts.writeToPty(id, text) : true
    },
    // A per-item modal firing during a batch would mean the batch leaked into the singular path.
    confirm: async () => {
      counters.singles += 1
      return { approved: true }
    },
    confirmBatch: async (req) => {
      batches.push(req)
      return opts.confirmBatch
        ? opts.confirmBatch(req)
        : { decisions: req.items.map(() => ({ approved: true })) }
    },
    audit: async (input) => {
      audits.push(input)
    },
    recordResult: () => {}
  }
  return {
    registry,
    audits,
    writes,
    batches,
    written: () => writes.filter((w) => w.text !== '\r').map((w) => w.id),
    get singles() {
      return counters.singles
    }
  }
}

const boards: Board[] = [
  { id: 'A', type: 'terminal', title: 'Alpha', status: 'running' },
  { id: 'B', type: 'terminal', title: 'Beta', status: 'running' },
  { id: 'D', type: 'browser', title: 'Web' }
]

describe('dispatchPrompts — one modal, N independent gated writes', () => {
  it('raises exactly ONE batch confirm and writes every approved row', async () => {
    const h = reg({ boards })
    const orch = buildOrchestrator(h.registry)
    const out = await orch.dispatchPrompts([
      { boardId: 'A', text: 'run alpha' },
      { boardId: 'B', text: 'run beta' }
    ])
    expect(h.batches).toHaveLength(1)
    expect(h.batches[0].items.map((i) => i.label)).toEqual(['Alpha', 'Beta'])
    expect(h.singles).toBe(0) // no per-item modal leaked through
    expect(out.map((r) => r.status)).toEqual(['dispatched', 'dispatched'])
    expect(h.written()).toEqual(['A', 'B'])
  })

  it('the modal body is the EXACT sanitized line that will be written', async () => {
    const h = reg({ boards })
    const orch = buildOrchestrator(h.registry)
    await orch.dispatchPrompts([{ boardId: 'A', text: 'do the thing' }])
    expect(h.batches[0].items[0].body).toBe('do the thing')
    expect(h.writes[0].text).toContain('do the thing')
  })

  it('🔒 a per-row denial blocks THAT row only — one approval never becomes two writes', async () => {
    const h = reg({
      boards,
      confirmBatch: async () => ({ decisions: [{ approved: true }, { approved: false }] })
    })
    const orch = buildOrchestrator(h.registry)
    const out = await orch.dispatchPrompts([
      { boardId: 'A', text: 'run alpha' },
      { boardId: 'B', text: 'run beta' }
    ])
    expect(out[0].status).toBe('dispatched')
    expect(out[1]).toMatchObject({ status: 'denied' })
    expect(h.written()).toEqual(['A'])
  })

  it('a missing batch confirm fails CLOSED — every row denied, nothing written', async () => {
    const h = reg({ boards })
    const bare = { ...h.registry, confirmBatch: undefined } as BoardRegistry
    const out = await buildOrchestrator(bare).dispatchPrompts([{ boardId: 'A', text: 'x' }])
    expect(out[0].status).toBe('denied')
    expect(h.writes).toHaveLength(0)
  })

  it('rejects a non-terminal target and an unknown id BEFORE the modal, and audits both', async () => {
    const h = reg({ boards })
    const orch = buildOrchestrator(h.registry)
    const out = await orch.dispatchPrompts([
      { boardId: 'D', text: 'x' },
      { boardId: 'ghost', text: 'y' },
      { boardId: 'A', text: 'z' }
    ])
    expect(out[0]).toMatchObject({ status: 'rejected' })
    expect(out[1]).toMatchObject({ status: 'rejected', detail: 'board not found' })
    expect(out[2].status).toBe('dispatched')
    // Only the valid row reached the human.
    expect(h.batches[0].items).toHaveLength(1)
    expect(h.audits.filter((a) => a.status === 'rejected')).toHaveLength(2)
  })

  it('rejects an embedded newline instead of flattening it (one approval = one line)', async () => {
    const h = reg({ boards })
    const out = await buildOrchestrator(h.registry).dispatchPrompts([
      { boardId: 'A', text: 'safe' },
      { boardId: 'B', text: 'rm -rf /\ndestroy' }
    ])
    expect(out[0].status).toBe('dispatched')
    expect(out[1]).toMatchObject({ status: 'rejected' })
    expect(out[1].detail).toContain('unsafe payload')
    expect(h.written()).toEqual(['A'])
  })

  it('every row rejected up front ⇒ no modal is raised at all', async () => {
    const h = reg({ boards })
    const out = await buildOrchestrator(h.registry).dispatchPrompts([{ boardId: 'D', text: 'x' }])
    expect(h.batches).toHaveLength(0)
    expect(out[0].status).toBe('rejected')
  })

  it('🔒 TOCTOU: a target that vanishes while the modal is open is not written to', async () => {
    const live: Board[] = [...boards]
    const h = reg({
      boards: live,
      confirmBatch: async (req) => {
        // The human deletes Beta while deciding.
        live.splice(
          live.findIndex((b) => b.id === 'B'),
          1
        )
        return { decisions: req.items.map(() => ({ approved: true })) }
      }
    })
    const out = await buildOrchestrator(h.registry).dispatchPrompts([
      { boardId: 'A', text: 'run alpha' },
      { boardId: 'B', text: 'run beta' }
    ])
    expect(out[0].status).toBe('dispatched')
    expect(out[1]).toMatchObject({ status: 'rejected' })
    expect(h.written()).toEqual(['A'])
  })

  it('an approved row whose PTY write fails reads `rejected`, not `denied`', async () => {
    const h = reg({ boards, writeToPty: (id) => id !== 'B' })
    const out = await buildOrchestrator(h.registry).dispatchPrompts([
      { boardId: 'A', text: 'a' },
      { boardId: 'B', text: 'b' }
    ])
    expect(out[0].status).toBe('dispatched')
    expect(out[1].status).toBe('rejected') // the human said yes; the machine failed
  })

  it('results stay positionally 1:1 with the input', async () => {
    const h = reg({ boards })
    const out = await buildOrchestrator(h.registry).dispatchPrompts([
      { boardId: 'D', text: 'x' },
      { boardId: 'A', text: 'y' },
      { boardId: 'ghost', text: 'z' }
    ])
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.boardId)).toEqual(['D', 'A', 'ghost'])
  })
})

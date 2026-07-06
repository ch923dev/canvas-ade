import { describe, it, expect } from 'vitest'
import { buildOrchestrator } from './mcpOrchestrator'
import type { BoardRegistry } from './mcpRegistry'
import type { AuditInput } from './auditLog'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import type { ConfirmBatchDecision, ConfirmBatchRequest } from './mcpConfirm'

// relayPrompts is the BATCH sibling of relayPrompt: validate every item up front (cable +
// terminal→terminal + sanitize), raise ONE per-row confirm modal, then run each valid row through
// the SAME shared write gate independently (own nonce, own TOCTOU re-check, own audit) with the
// human's per-row decision fed in via the gate's confirmOverride seam.

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

type Board = { id: string; type: string; title: string; status?: string }
type Conn = { id: string; sourceId: string; targetId: string; kind: string }

function reg(opts: {
  boards: Board[]
  connectors?: Conn[]
  confirmBatch?: (req: ConfirmBatchRequest) => Promise<ConfirmBatchDecision>
  writeToPty?: (id: string, text: string) => boolean
}): {
  registry: BoardRegistry
  audits: AuditInput[]
  writes: Array<{ id: string; text: string }>
  batches: ConfirmBatchRequest[]
} {
  const audits: AuditInput[] = []
  const writes: Array<{ id: string; text: string }> = []
  const batches: ConfirmBatchRequest[] = []
  const registry: BoardRegistry = {
    listBoards: () => opts.boards,
    listConnectors: () => opts.connectors ?? [],
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
    confirm: async () => ({ approved: true }),
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
  return { registry, audits, writes, batches }
}

const boards: Board[] = [
  { id: 'A', type: 'terminal', title: 'Alpha', status: 'running' },
  { id: 'B', type: 'terminal', title: 'Beta', status: 'running' },
  { id: 'C', type: 'terminal', title: 'Gamma', status: 'running' },
  { id: 'D', type: 'browser', title: 'Web' }
]
const cables: Conn[] = [
  { id: 'c1', sourceId: 'A', targetId: 'B', kind: 'orchestration' },
  { id: 'c2', sourceId: 'A', targetId: 'C', kind: 'orchestration' }
]

describe('🔒 relayPrompts (batch agent-to-agent dispatch)', () => {
  it('happy path: all valid + all approved → ONE batch modal, per-target writes, all relayed', async () => {
    const { registry, writes, batches } = reg({ boards, connectors: cables })
    const orch = buildOrchestrator(registry)
    const results = await orch.relayPrompts([
      { sourceId: 'A', targetId: 'B', text: 'pnpm build' },
      { sourceId: 'A', targetId: 'C', text: 'pnpm test' }
    ])
    expect(batches).toHaveLength(1) // ONE modal for the whole batch
    expect(batches[0].items).toHaveLength(2)
    expect(writes).toEqual([
      { id: 'B', text: 'pnpm build' },
      { id: 'B', text: '\r' },
      { id: 'C', text: 'pnpm test' },
      { id: 'C', text: '\r' }
    ])
    expect(results.map((r) => r.status)).toEqual(['relayed', 'relayed'])
  })

  it('per-row: only approved rows are written; a denied row writes nothing but audits denied', async () => {
    const { registry, writes, audits } = reg({
      boards,
      connectors: cables,
      confirmBatch: async () => ({ decisions: [{ approved: true }, { approved: false }] })
    })
    const orch = buildOrchestrator(registry)
    const results = await orch.relayPrompts([
      { sourceId: 'A', targetId: 'B', text: 'pnpm build' },
      { sourceId: 'A', targetId: 'C', text: 'rm -rf dist' }
    ])
    expect(writes).toEqual([
      { id: 'B', text: 'pnpm build' },
      { id: 'B', text: '\r' }
    ])
    expect(results[0].status).toBe('relayed')
    expect(results[1].status).toBe('denied')
    expect(audits.some((a) => a.status === 'denied')).toBe(true)
  })

  it('🔒 an invalid row (no cable) is rejected up front — never shown in the modal; valid rows still run', async () => {
    const { registry, batches, writes } = reg({ boards, connectors: cables })
    const orch = buildOrchestrator(registry)
    const results = await orch.relayPrompts([
      { sourceId: 'A', targetId: 'B', text: 'ok' }, // valid
      { sourceId: 'A', targetId: 'Z', text: 'no cable' } // Z absent + no cable → rejected
    ])
    expect(batches[0].items).toHaveLength(1) // only the valid row reaches the modal
    expect(results[0].status).toBe('relayed')
    expect(results[1].status).toBe('rejected')
    expect(writes.every((w) => w.id === 'B')).toBe(true)
  })

  it('🔒 a non-terminal target row is rejected (never Browser→PTY)', async () => {
    const { registry } = reg({
      boards,
      connectors: [...cables, { id: 'c3', sourceId: 'A', targetId: 'D', kind: 'orchestration' }]
    })
    const orch = buildOrchestrator(registry)
    const results = await orch.relayPrompts([{ sourceId: 'A', targetId: 'D', text: 'x' }])
    expect(results[0].status).toBe('rejected')
  })

  it('🔒 a row whose prompt has an embedded newline is rejected up front (one-command-line invariant)', async () => {
    const { registry, batches } = reg({ boards, connectors: cables })
    const orch = buildOrchestrator(registry)
    const results = await orch.relayPrompts([
      { sourceId: 'A', targetId: 'B', text: 'good' },
      { sourceId: 'A', targetId: 'C', text: 'line1\nline2' }
    ])
    expect(batches[0].items).toHaveLength(1) // the CR/LF row never reaches the modal
    expect(results[1].status).toBe('rejected')
  })

  it('🔒 the modal row shows the SANITIZED command body (control chars stripped) + the resolved route', async () => {
    const { registry, batches } = reg({ boards, connectors: cables })
    const orch = buildOrchestrator(registry)
    await orch.relayPrompts([{ sourceId: 'A', targetId: 'B', text: 'echo \x07hi' }])
    expect(batches[0].items[0].body).toBe('echo hi') // the bell (0x07) is stripped
    expect(batches[0].items[0].label).toContain('Alpha')
    expect(batches[0].items[0].label).toContain('Beta')
  })

  it('every row invalid → no modal is shown at all', async () => {
    const { registry, batches } = reg({ boards, connectors: [] })
    const orch = buildOrchestrator(registry)
    const results = await orch.relayPrompts([{ sourceId: 'A', targetId: 'B', text: 'x' }])
    expect(batches).toEqual([])
    expect(results[0].status).toBe('rejected')
  })
})

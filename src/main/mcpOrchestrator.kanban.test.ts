import { describe, it, expect } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { AuditInput } from './auditLog'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

interface Harness {
  registry: BoardRegistry
  sent: McpCommand[]
  audits: AuditInput[]
  confirms: Array<{ title: string; body: string }>
}

function harness(
  boards: Array<{ id: string; type: string; title: string }>,
  opts: { approve?: boolean; ackOk?: boolean } = {}
): Harness {
  const sent: McpCommand[] = []
  const audits: AuditInput[] = []
  const confirms: Array<{ title: string; body: string }> = []
  const approve = opts.approve ?? true
  const ackOk = opts.ackOk ?? true
  const registry: BoardRegistry = {
    listBoards: () => boards,
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
      return ackOk ? { ok: true, type: cmd.type } : { ok: false, error: 'renderer rejected' }
    },
    confirm: async (req) => {
      confirms.push(req)
      return { approved: approve }
    },
    audit: async (e) => {
      audits.push(e)
    }
  }
  return { registry, sent, audits, confirms }
}

const kanban = [{ id: 'k1', type: 'kanban', title: 'Auth plan' }]

describe('orchestrator kanban card writes (P3 gate)', () => {
  it('addCard: confirm shows the card → patchKanban add op sent (host-minted id) → audit applied → returns id', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    const { id } = await orch.addCard('k1', {
      columnId: 'backlog',
      title: 'Wire auth gate',
      tag: 'feature',
      assignee: 'claude'
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    // Confirm body shows the exact card (not a bare count).
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].body).toContain('Wire auth gate')
    expect(h.confirms[0].body).toContain('backlog')
    // One patchKanban command carrying the sanitized add op with the SAME minted id returned.
    expect(h.sent).toHaveLength(1)
    const cmd = h.sent[0]
    expect(cmd.type).toBe('patchKanban')
    if (cmd.type === 'patchKanban') {
      expect(cmd.id).toBe('k1')
      expect(cmd.ops).toEqual([
        {
          op: 'add',
          card: {
            id,
            columnId: 'backlog',
            title: 'Wire auth gate',
            tag: 'feature',
            assignee: 'claude'
          }
        }
      ])
    }
    const applied = h.audits.find((a) => a.status === 'applied')
    expect(applied?.type).toBe('add_card')
    expect(applied?.targetId).toBe('k1')
  })

  it('moveCard / updateCard / removeCard send the matching patchKanban op', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    await orch.moveCard('k1', 'c9', 'review')
    await orch.updateCard('k1', 'c9', { tag: 'shipped' })
    await orch.removeCard('k1', 'c9')
    expect(h.sent.map((c) => (c.type === 'patchKanban' ? c.ops[0] : null))).toEqual([
      { op: 'move', cardId: 'c9', toColumnId: 'review' },
      { op: 'update', cardId: 'c9', patch: { tag: 'shipped' } },
      { op: 'remove', cardId: 'c9' }
    ])
    expect(h.audits.filter((a) => a.status === 'applied').map((a) => a.type)).toEqual([
      'move_card',
      'update_card',
      'remove_card'
    ])
  })

  it('sanitizes card text (control chars stripped, whitespace collapsed) before confirm/send', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    await orch.addCard('k1', { columnId: 'backlog', title: 'a\tb\x07\x1b  c\nd' })
    const cmd = h.sent[0]
    if (cmd.type === 'patchKanban' && cmd.ops[0].op === 'add') {
      expect(cmd.ops[0].card.title).toBe('a b c d') // tabs/newline collapsed, BEL+ESC stripped
    } else {
      throw new Error('expected an add patchKanban op')
    }
  })

  it('rejects a non-kanban target: nothing sent, audit rejected, throws', async () => {
    const h = harness([{ id: 'p1', type: 'planning', title: 'Plan' }])
    const orch = buildOrchestrator(h.registry)
    await expect(orch.addCard('p1', { columnId: 'backlog', title: 'x' })).rejects.toThrow(
      /not a kanban/
    )
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('rejects an unknown board: nothing sent, throws', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    await expect(orch.moveCard('nope', 'c1', 'done')).rejects.toThrow(/board not found/)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('declined confirm: nothing sent, audit denied, throws', async () => {
    const h = harness(kanban, { approve: false })
    const orch = buildOrchestrator(h.registry)
    await expect(orch.addCard('k1', { columnId: 'backlog', title: 'x' })).rejects.toThrow(/denied/)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'denied')).toBe(true)
  })

  it('rejects invalid content (empty title) BEFORE the human gate', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    await expect(orch.addCard('k1', { columnId: 'backlog', title: '   ' })).rejects.toThrow()
    expect(h.confirms).toHaveLength(0) // never shown to the human
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('addCard carries the v19 detail fields through confirm + the patchKanban add op', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    await orch.addCard('k1', {
      columnId: 'backlog',
      title: 'Wire auth',
      description: 'token middleware',
      tags: ['feature', 'security'],
      fileRefs: [{ path: 'src/auth/mw.ts', line: 12, endLine: 20 }]
    })
    // The human sees the detail on the confirm body.
    expect(h.confirms[0].body).toContain('tags: feature, security')
    expect(h.confirms[0].body).toContain('files: src/auth/mw.ts:12-20')
    expect(h.confirms[0].body).toContain('description: token middleware')
    const cmd = h.sent[0]
    if (cmd.type === 'patchKanban' && cmd.ops[0].op === 'add') {
      expect(cmd.ops[0].card.description).toBe('token middleware')
      expect(cmd.ops[0].card.tags).toEqual(['feature', 'security'])
      expect(cmd.ops[0].card.fileRefs).toEqual([{ path: 'src/auth/mw.ts', line: 12, endLine: 20 }])
    } else {
      throw new Error('expected an add patchKanban op')
    }
  })
})

describe('orchestrator kanban axis config (v19 configure_board gate)', () => {
  it('configureBoard(columnAxis/axisLabel): confirm → configureBoard command → audit configured', async () => {
    const h = harness(kanban)
    const orch = buildOrchestrator(h.registry)
    await orch.configureBoard('k1', { columnAxis: 'category', axisLabel: 'Subsystem' })
    // Human-confirmed (axisLabel is renderable content, ADR 0003).
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].body).toContain('axis: category')
    expect(h.confirms[0].body).toContain('label: Subsystem')
    // One configureBoard command carrying the sanitized axis patch.
    expect(h.sent).toEqual([
      {
        type: 'configureBoard',
        id: 'k1',
        patch: { columnAxis: 'category', axisLabel: 'Subsystem' }
      }
    ])
    expect(h.audits.some((a) => a.type === 'configure_board' && a.status === 'configured')).toBe(
      true
    )
  })

  it('rejects an axis config on a NON-kanban board (nothing sent, audit rejected)', async () => {
    const h = harness([{ id: 't1', type: 'terminal', title: 'Term' }])
    const orch = buildOrchestrator(h.registry)
    await expect(orch.configureBoard('t1', { columnAxis: 'flow' })).rejects.toThrow(/not a kanban/)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('declined axis confirm: nothing sent, audit denied, throws', async () => {
    const h = harness(kanban, { approve: false })
    const orch = buildOrchestrator(h.registry)
    await expect(orch.configureBoard('k1', { axisLabel: 'Phase' })).rejects.toThrow(/denied/)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'denied')).toBe(true)
  })
})

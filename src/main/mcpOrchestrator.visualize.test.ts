import { describe, it, expect } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { ConfirmRequest } from './mcpConfirm'
import type { AuditInput } from './auditLog'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

interface Harness {
  registry: BoardRegistry
  sent: McpCommand[]
  audits: AuditInput[]
  confirms: ConfirmRequest[]
}

/** A registry whose confirm returns a configurable {approved, choice} — the P5 chooser reply. */
function harness(opts: { approve?: boolean; choice?: string; ackOk?: boolean } = {}): Harness {
  const sent: McpCommand[] = []
  const audits: AuditInput[] = []
  const confirms: ConfirmRequest[] = []
  const approve = opts.approve ?? true
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
      return ackOk ? { ok: true, type: cmd.type } : { ok: false, error: 'renderer rejected' }
    },
    confirm: async (req) => {
      confirms.push(req)
      return { approved: approve, ...(opts.choice !== undefined ? { choice: opts.choice } : {}) }
    },
    audit: async (e) => {
      audits.push(e)
    }
  }
  return { registry, sent, audits, confirms }
}

const PLAN = [
  { title: 'Audit tokens', status: 'backlog', tag: 'research' },
  { title: 'Wire PKCE', status: 'in progress', assignee: 'claude' }
]

describe('orchestrator visualizePlan (P5 gate)', () => {
  it('confirms with the chooser (suggestion preselected) → sends the picked shape → audit applied → returns minted id', async () => {
    const h = harness({ choice: 'kanban' })
    const orch = buildOrchestrator(h.registry)
    const { id } = await orch.visualizePlan({
      items: PLAN,
      suggested: 'kanban',
      title: 'Auth plan'
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    // The confirm carried the full plan + the chooser with the suggestion preselected.
    expect(h.confirms).toHaveLength(1)
    const req = h.confirms[0]
    expect(req.body).toContain('Audit tokens')
    expect(req.body).toContain('Wire PKCE')
    expect(req.choices?.default).toBe('kanban')
    expect(req.choices?.options.map((o) => o.id)).toEqual([
      'kanban',
      'grid',
      'checklist',
      'columns'
    ])
    // One visualizePlan command with the SAME minted id + the sanitized items + the picked shape.
    expect(h.sent).toHaveLength(1)
    const cmd = h.sent[0]
    expect(cmd.type).toBe('visualizePlan')
    if (cmd.type === 'visualizePlan') {
      expect(cmd.id).toBe(id)
      expect(cmd.visualization).toBe('kanban')
      expect(cmd.title).toBe('Auth plan')
      expect(cmd.items).toEqual(PLAN)
    }
    const applied = h.audits.find((a) => a.status === 'applied')
    expect(applied?.type).toBe('visualize_plan')
    expect(applied?.targetId).toBe(id)
  })

  it('uses the HUMAN pick over the suggestion (chooser overrides)', async () => {
    const h = harness({ choice: 'columns' })
    const orch = buildOrchestrator(h.registry)
    await orch.visualizePlan({ items: PLAN, suggested: 'kanban' })
    const cmd = h.sent[0]
    expect(cmd.type === 'visualizePlan' && cmd.visualization).toBe('columns')
  })

  it('falls back to the suggestion for an off-set / absent choice (fail-safe)', async () => {
    const bogus = harness({ choice: 'malware' })
    await buildOrchestrator(bogus.registry).visualizePlan({ items: PLAN, suggested: 'checklist' })
    expect(bogus.sent[0].type === 'visualizePlan' && bogus.sent[0].visualization).toBe('checklist')

    const none = harness({}) // approved, no choice returned
    await buildOrchestrator(none.registry).visualizePlan({ items: PLAN, suggested: 'grid' })
    expect(none.sent[0].type === 'visualizePlan' && none.sent[0].visualization).toBe('grid')
  })

  it('an absent/invalid suggestion preselects grid', async () => {
    const h = harness({ choice: 'grid' })
    await buildOrchestrator(h.registry).visualizePlan({ items: PLAN })
    expect(h.confirms[0].choices?.default).toBe('grid')
  })

  it('declined confirm: nothing sent, audit denied, throws', async () => {
    const h = harness({ approve: false })
    const orch = buildOrchestrator(h.registry)
    await expect(orch.visualizePlan({ items: PLAN, suggested: 'grid' })).rejects.toThrow(/declined/)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'denied')).toBe(true)
  })

  it('rejects invalid content (empty items) BEFORE the human gate', async () => {
    const h = harness()
    const orch = buildOrchestrator(h.registry)
    await expect(orch.visualizePlan({ items: [] })).rejects.toThrow()
    expect(h.confirms).toHaveLength(0) // never shown to the human
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('sanitizes item fields (control chars stripped) before confirm/send', async () => {
    const h = harness({ choice: 'grid' })
    const orch = buildOrchestrator(h.registry)
    await orch.visualizePlan({ items: [{ title: 'a\tb\x07  c' }], suggested: 'grid' })
    const cmd = h.sent[0]
    if (cmd.type === 'visualizePlan') {
      expect(cmd.items[0].title).toBe('a b c')
    } else {
      throw new Error('expected a visualizePlan command')
    }
  })

  it('a false ack audits failed and throws', async () => {
    const h = harness({ choice: 'grid', ackOk: false })
    const orch = buildOrchestrator(h.registry)
    await expect(orch.visualizePlan({ items: PLAN, suggested: 'grid' })).rejects.toThrow(/failed/)
    expect(h.audits.some((a) => a.status === 'failed')).toBe(true)
  })
})

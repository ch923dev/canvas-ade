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

/** A registry with spies for sendCommand/confirm/audit, tuned per test. */
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

const planning = [{ id: 'plan-1', type: 'planning', title: 'My Plan' }]

describe('orchestrator.addPlanningElements (S2 content write gate)', () => {
  it('happy path: confirm shows FULL content → patchPlanning sent → audit "applied"', async () => {
    const h = harness(planning, { approve: true })
    const orch = buildOrchestrator(h.registry)
    await orch.addPlanningElements('plan-1', {
      elements: [
        { kind: 'note', text: 'audit mw', tint: 'blue' },
        { kind: 'checklist', title: 'Auth', items: [{ label: 'wire gate' }] }
      ]
    })
    // The confirm body carries the full content (not a bare count) for the human gate.
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].body).toContain('audit mw')
    expect(h.confirms[0].body).toContain('☐ wire gate')
    // One patchPlanning command with the sanitized ops.
    expect(h.sent).toHaveLength(1)
    const cmd = h.sent[0]
    expect(cmd.type).toBe('patchPlanning')
    if (cmd.type === 'patchPlanning') {
      expect(cmd.id).toBe('plan-1')
      expect(cmd.ops[0]).toEqual({ kind: 'note', text: 'audit mw', tint: 'blue' })
    }
    // Audit records the landed write with status 'applied' + full content in `prompt`.
    const applied = h.audits.find((a) => a.status === 'applied')
    expect(applied).toBeDefined()
    expect(applied?.type).toBe('add_planning_elements')
    expect(applied?.targetId).toBe('plan-1')
    expect(applied?.prompt).toContain('audit mw')
  })

  it('sanitizes content before it is shown or sent (control chars stripped, newlines kept)', async () => {
    const h = harness(planning)
    const orch = buildOrchestrator(h.registry)
    await orch.addPlanningElements('plan-1', {
      elements: [{ kind: 'note', text: 'line1\nline2\x07\x1b', tint: 'plain' }]
    })
    const cmd = h.sent[0]
    if (cmd.type === 'patchPlanning' && cmd.ops[0].kind === 'note') {
      expect(cmd.ops[0].text).toBe('line1\nline2') // BEL + ESC stripped, newline preserved
    } else {
      throw new Error('expected a note patchPlanning op')
    }
  })

  it('declined: confirm denied → NOTHING sent → audit "denied" → throws', async () => {
    const h = harness(planning, { approve: false })
    const orch = buildOrchestrator(h.registry)
    await expect(
      orch.addPlanningElements('plan-1', { elements: [{ kind: 'note', text: 'x' }] })
    ).rejects.toThrow(/denied/)
    expect(h.sent).toEqual([]) // no write reached the renderer
    expect(h.audits.some((a) => a.status === 'denied')).toBe(true)
  })

  it('rejects a non-planning target BEFORE any confirm (audit "rejected")', async () => {
    const h = harness([{ id: 'term-1', type: 'terminal', title: 'Term' }])
    const orch = buildOrchestrator(h.registry)
    await expect(
      orch.addPlanningElements('term-1', { elements: [{ kind: 'note', text: 'x' }] })
    ).rejects.toThrow(/not a planning board/)
    expect(h.confirms).toEqual([])
    expect(h.sent).toEqual([])
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('rejects an unknown board id (audit "rejected", no confirm)', async () => {
    const h = harness(planning)
    const orch = buildOrchestrator(h.registry)
    await expect(
      orch.addPlanningElements('ghost', { elements: [{ kind: 'note', text: 'x' }] })
    ).rejects.toThrow(/board not found/)
    expect(h.confirms).toEqual([])
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('rejects invalid content BEFORE the human gate (audit "rejected", no confirm)', async () => {
    const h = harness(planning)
    const orch = buildOrchestrator(h.registry)
    await expect(
      // unknown kind → buildPlanningOps throws PlanningContentError. Cast: deliberately
      // off-shape input exercising MAIN's runtime validation of untrusted agent content.
      orch.addPlanningElements('plan-1', { elements: [{ kind: 'diagram', source: 'x' }] as never })
    ).rejects.toThrow()
    expect(h.confirms).toEqual([])
    expect(h.sent).toEqual([])
    expect(h.audits.some((a) => a.status === 'rejected')).toBe(true)
  })

  it('approved but the renderer apply fails → audit "failed" → throws', async () => {
    const h = harness(planning, { approve: true, ackOk: false })
    const orch = buildOrchestrator(h.registry)
    await expect(
      orch.addPlanningElements('plan-1', { elements: [{ kind: 'note', text: 'x' }] })
    ).rejects.toThrow(/failed/)
    expect(h.audits.some((a) => a.status === 'failed')).toBe(true)
  })
})

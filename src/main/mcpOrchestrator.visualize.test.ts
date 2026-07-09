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
  enqueued: Array<{ dir: string; command: McpCommand }>
}

/** A registry whose confirm returns a configurable {approved, choice} — the P5 chooser reply.
 *  `routing` wires the cross-project trio: `currentDir` is read fresh per call (pass a fn to
 *  simulate a switch mid-confirm); `boardDirs` is the boardId → mint-dir map; `enqueueOk: false`
 *  simulates a full queue. */
function harness(
  opts: {
    approve?: boolean
    choice?: string
    ackOk?: boolean
    routing?: {
      currentDir: () => string | null
      boardDirs?: Record<string, string>
      enqueueOk?: boolean
    }
  } = {}
): Harness {
  const sent: McpCommand[] = []
  const audits: AuditInput[] = []
  const confirms: ConfirmRequest[] = []
  const enqueued: Array<{ dir: string; command: McpCommand }> = []
  const approve = opts.approve ?? true
  const ackOk = opts.ackOk ?? true
  const routing = opts.routing
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
    },
    ...(routing !== undefined
      ? {
          currentProjectDir: routing.currentDir,
          boardProjectDir: (boardId: string) => routing.boardDirs?.[boardId] ?? null,
          enqueueProjectCommand: (dir: string, command: McpCommand) => {
            if (routing.enqueueOk === false) return false
            enqueued.push({ dir, command })
            return true
          }
        }
      : {})
  }
  return { registry, sent, audits, confirms, enqueued }
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

describe('orchestrator visualizePlan — cross-project routing (2026-07-09)', () => {
  const ROUTING = {
    currentDir: () => 'C:\\proj\\active',
    boardDirs: { 'term-bg': 'C:\\proj\\background', 'term-fg': 'C:\\proj\\active' }
  }

  it('a BACKGROUND project caller: confirm names the target project, command is QUEUED (not sent), returns queuedFor', async () => {
    const h = harness({ choice: 'kanban', routing: ROUTING })
    const orch = buildOrchestrator(h.registry)
    const { id, queuedFor } = await orch.visualizePlan({
      items: PLAN,
      suggested: 'kanban',
      sourceBoardId: 'term-bg'
    })
    // The human saw WHERE the board will land — approving a background-canvas write knowingly.
    expect(h.confirms[0].body).toContain('Target project: background')
    // Queued for the CALLER'S project; nothing drawn on the active canvas.
    expect(h.sent).toHaveLength(0)
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0].dir).toBe('C:\\proj\\background')
    const cmd = h.enqueued[0].command
    expect(cmd.type === 'visualizePlan' && cmd.id).toBe(id)
    expect(cmd.type === 'visualizePlan' && cmd.visualization).toBe('kanban')
    expect(queuedFor).toBe('background')
    const applied = h.audits.find((a) => a.status === 'applied')
    expect(applied?.detail).toContain('queued for C:\\proj\\background')
  })

  it('an ACTIVE project caller keeps the live path (sent, no queue, no queuedFor)', async () => {
    const h = harness({ choice: 'grid', routing: ROUTING })
    const { queuedFor } = await buildOrchestrator(h.registry).visualizePlan({
      items: PLAN,
      sourceBoardId: 'term-fg'
    })
    expect(queuedFor).toBeUndefined()
    expect(h.sent).toHaveLength(1)
    expect(h.enqueued).toHaveLength(0)
    expect(h.confirms[0].body).not.toContain('Target project:')
  })

  it('an UNKNOWN sourceBoardId (no mint record) falls back to the live path', async () => {
    const h = harness({ choice: 'grid', routing: ROUTING })
    const { queuedFor } = await buildOrchestrator(h.registry).visualizePlan({
      items: PLAN,
      sourceBoardId: 'never-minted'
    })
    expect(queuedFor).toBeUndefined()
    expect(h.sent).toHaveLength(1)
    expect(h.enqueued).toHaveLength(0)
  })

  it('an UNWIRED registry (no routing deps) ignores sourceBoardId entirely (legacy behaviour)', async () => {
    const h = harness({ choice: 'grid' })
    const { queuedFor } = await buildOrchestrator(h.registry).visualizePlan({
      items: PLAN,
      sourceBoardId: 'term-bg'
    })
    expect(queuedFor).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it('re-resolves the active project AFTER the confirm — a switch during the modal cannot misroute', async () => {
    // At confirm time the caller IS the active project; the user switches away while the modal
    // is open, so at apply time it no longer is → the command must queue for the caller's dir.
    const dirs = ['C:\\proj\\background', 'C:\\proj\\other']
    const h = harness({
      choice: 'grid',
      routing: {
        currentDir: () => dirs.shift() ?? 'C:\\proj\\other',
        boardDirs: { 'term-bg': 'C:\\proj\\background' }
      }
    })
    const { queuedFor } = await buildOrchestrator(h.registry).visualizePlan({
      items: PLAN,
      sourceBoardId: 'term-bg'
    })
    expect(h.confirms[0].body).not.toContain('Target project:') // active at confirm — no note
    expect(h.sent).toHaveLength(0)
    expect(h.enqueued.map((e) => e.dir)).toEqual(['C:\\proj\\background'])
    expect(queuedFor).toBe('background')
  })

  it('a FULL queue audits failed and throws (nothing sent, nothing silently dropped)', async () => {
    const h = harness({ choice: 'grid', routing: { ...ROUTING, enqueueOk: false } })
    await expect(
      buildOrchestrator(h.registry).visualizePlan({ items: PLAN, sourceBoardId: 'term-bg' })
    ).rejects.toThrow(/queue is full/)
    expect(h.sent).toHaveLength(0)
    expect(h.audits.some((a) => a.status === 'failed')).toBe(true)
  })
})

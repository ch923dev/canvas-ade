import { describe, expect, it } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@ch923dev/canvas-ade-mcp'
import { buildOrchestrator, MCP_SPAWN_CAP, type BoardRegistry } from './mcpOrchestrator'
import type { McpCommand, McpCommandAck } from './mcpCommand'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

/** A sendCommand that always acks ok and records the commands it saw, plus a drainPty spy. */
function okCommands(): {
  sendCommand: BoardRegistry['sendCommand']
  drainPty: BoardRegistry['drainPty']
  seen: McpCommand[]
  drained: string[]
} {
  const seen: McpCommand[] = []
  const drained: string[] = []
  return {
    seen,
    drained,
    sendCommand: async (cmd) => {
      seen.push(cmd)
      return { ok: true, type: cmd.type }
    },
    drainPty: async (id) => {
      drained.push(id)
    }
  }
}

function reg(
  boards: Array<{ id: string; type: string; title: string; status?: string }>,
  sessions: Array<{ id: string; status: string }> = [],
  outputs: Record<string, BoardOutput> = {},
  resultsById: Record<string, BoardResult> = {},
  memory: { project?: MemoryDoc; summaries?: Record<string, MemoryDoc> } = {},
  sendCommand: BoardRegistry['sendCommand'] = async (cmd): Promise<McpCommandAck> => ({
    ok: true,
    type: cmd.type
  }),
  drainPty: BoardRegistry['drainPty'] = async () => {}
): BoardRegistry {
  return {
    listBoards: () => boards,
    listSessions: () => sessions,
    readOutput: (id) => outputs[id] ?? EMPTY_OUTPUT,
    readResult: (id) => resultsById[id] ?? EMPTY_RESULT,
    readMemory: () => memory.project ?? EMPTY_MEMORY,
    readSummary: (id) => memory.summaries?.[id] ?? EMPTY_MEMORY,
    sendCommand,
    drainPty
  }
}

describe('buildOrchestrator', () => {
  it('prefers the renderer-supplied status bucket for every board', async () => {
    const orch = buildOrchestrator(
      reg([
        { id: 't1', type: 'terminal', title: 'Term', status: 'running' },
        { id: 'b1', type: 'browser', title: 'Web', status: 'failed' },
        { id: 'p1', type: 'planning', title: 'Plan', status: 'static' }
      ])
    )
    expect(await orch.listBoards()).toEqual([
      { id: 't1', type: 'terminal', title: 'Term', status: 'running' },
      { id: 'b1', type: 'browser', title: 'Web', status: 'failed' },
      { id: 'p1', type: 'planning', title: 'Plan', status: 'static' }
    ])
  })

  it('falls back to a PTY/presence-derived bucket when the mirror carries no status', async () => {
    const orch = buildOrchestrator(
      reg(
        [
          { id: 't1', type: 'terminal', title: 'Term' },
          { id: 't2', type: 'terminal', title: 'Idle' },
          { id: 'b1', type: 'browser', title: 'Web' },
          { id: 'p1', type: 'planning', title: 'Plan' },
          { id: 'x1', type: 'whatever', title: 'Fwd' }
        ],
        [{ id: 't1', status: 'running' }]
      )
    )
    expect(await orch.listBoards()).toEqual([
      { id: 't1', type: 'terminal', title: 'Term', status: 'running' },
      { id: 't2', type: 'terminal', title: 'Idle', status: 'idle' },
      { id: 'b1', type: 'browser', title: 'Web', status: 'idle' },
      { id: 'p1', type: 'planning', title: 'Plan', status: 'static' },
      { id: 'x1', type: 'whatever', title: 'Fwd', status: 'static' }
    ])
  })

  it('boardStatus returns the bucket (mirror status wins over the PTY map)', async () => {
    const orch = buildOrchestrator(
      reg(
        [{ id: 't1', type: 'terminal', title: 'T', status: 'awaiting-review' }],
        [{ id: 't1', status: 'running' }]
      )
    )
    expect(await orch.boardStatus('t1')).toBe('awaiting-review')
  })

  it('a terminal board with no mirror status and no live PTY reads idle', async () => {
    const orch = buildOrchestrator(reg([{ id: 't1', type: 'terminal', title: 'T' }]))
    expect(await orch.boardStatus('t1')).toBe('idle')
  })

  it('boardStatus throws for an unknown board', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.boardStatus('nope')).rejects.toThrow(/not found/)
  })

  it('boardOutput delegates the cursor to the registry and returns its page', async () => {
    let seenCursor: number | undefined = -1
    const page: BoardOutput = {
      text: 'hello',
      total: 5,
      returned: 5,
      nextCursor: 25_000,
      droppedOlder: true
    }
    const orch = buildOrchestrator({
      listBoards: () => [{ id: 't1', type: 'terminal', title: 'T' }],
      listSessions: () => [],
      readOutput: (_id, opts) => {
        seenCursor = opts?.cursor
        return page
      },
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => ({ ok: true, type: cmd.type }),
      drainPty: async () => {}
    })
    expect(await orch.boardOutput('t1', { cursor: 12345 })).toEqual(page)
    expect(seenCursor).toBe(12345)
  })

  it('boardOutput on an absent board reads an empty page (output is observational)', async () => {
    const orch = buildOrchestrator(reg([]))
    expect(await orch.boardOutput('ghost')).toEqual(EMPTY_OUTPUT)
  })

  it('boardResult delegates to the registry and returns the structured result', async () => {
    const result: BoardResult = { present: true, status: 'success', summary: 'ok', refs: ['a.ts'] }
    const orch = buildOrchestrator(reg([], [], {}, { t1: result }))
    expect(await orch.boardResult('t1')).toEqual(result)
  })

  it('boardResult on a board with no result reads the empty shell', async () => {
    const orch = buildOrchestrator(reg([]))
    expect(await orch.boardResult('ghost')).toEqual(EMPTY_RESULT)
  })

  it('projectMemory + boardSummary delegate to the registry (T1.7)', async () => {
    const project: MemoryDoc = { present: true, text: '# memory' }
    const sum: MemoryDoc = { present: true, text: 'board t1' }
    const orch = buildOrchestrator(reg([], [], {}, {}, { project, summaries: { t1: sum } }))
    expect(await orch.projectMemory()).toEqual(project)
    expect(await orch.boardSummary('t1')).toEqual(sum)
    expect(await orch.boardSummary('ghost')).toEqual(EMPTY_MEMORY)
  })

  it('dispatchPrompt / gitDiff stay phase-gated (M3 unblocks ONLY spawn)', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.dispatchPrompt('b', 'x')).rejects.toThrow(/Phase 4/)
    await expect(orch.gitDiff('b')).rejects.toThrow(/Phase 6/)
  })

  describe('spawnBoard (T3.1, lifecycle write)', () => {
    it('mints an id, issues an addBoard command with it, and returns it', async () => {
      const { sendCommand, seen } = okCommands()
      const orch = buildOrchestrator(reg([], [], {}, {}, {}, sendCommand))
      const { id } = await orch.spawnBoard({ type: 'terminal' })
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
      expect(seen).toEqual([{ type: 'addBoard', board: { id, type: 'terminal' } }])
    })

    it('throws when the renderer rejects the command (no silent failure)', async () => {
      const orch = buildOrchestrator(
        reg([], [], {}, {}, {}, async () => ({ ok: false, error: 'no-window' }))
      )
      await expect(orch.spawnBoard({ type: 'browser' })).rejects.toThrow(/no-window/)
    })

    it('🔒 rejects a spawn once the concurrency cap is reached', async () => {
      const { sendCommand } = okCommands()
      const orch = buildOrchestrator(reg([], [], {}, {}, {}, sendCommand))
      for (let i = 0; i < MCP_SPAWN_CAP; i++) {
        await orch.spawnBoard({ type: 'terminal' })
      }
      await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
    })
  })

  describe('closeBoard (T3.2, lifecycle write)', () => {
    it('drains the PTY THEN issues a removeBoard command for that id', async () => {
      const { sendCommand, drainPty, seen, drained } = okCommands()
      const orch = buildOrchestrator(reg([], [], {}, {}, {}, sendCommand, drainPty))
      await orch.closeBoard('board-9')
      expect(drained).toEqual(['board-9']) // graceful drain happened
      expect(seen).toEqual([{ type: 'removeBoard', id: 'board-9' }]) // then the canvas removal
    })

    it('throws when the renderer rejects the removeBoard command (no silent failure)', async () => {
      const { drainPty } = okCommands()
      const orch = buildOrchestrator(
        reg([], [], {}, {}, {}, async () => ({ ok: false, error: 'no-window' }), drainPty)
      )
      await expect(orch.closeBoard('b')).rejects.toThrow(/no-window/)
    })

    it('frees a cap slot so a new spawn succeeds after a close', async () => {
      const { sendCommand, drainPty } = okCommands()
      const orch = buildOrchestrator(reg([], [], {}, {}, {}, sendCommand, drainPty))
      const ids: string[] = []
      for (let i = 0; i < MCP_SPAWN_CAP; i++) {
        ids.push((await orch.spawnBoard({ type: 'terminal' })).id)
      }
      // At the cap — the next spawn must reject…
      await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
      // …until we close one, which frees a slot.
      await orch.closeBoard(ids[0])
      await expect(orch.spawnBoard({ type: 'terminal' })).resolves.toHaveProperty('id')
    })
  })

  describe('configureBoard (T3.3, lifecycle write)', () => {
    it('issues a configureBoard command with the id + patch', async () => {
      const { sendCommand, seen } = okCommands()
      const orch = buildOrchestrator(reg([], [], {}, {}, {}, sendCommand))
      await orch.configureBoard('board-5', { launchCommand: 'claude', cwd: '/repo' })
      expect(seen).toEqual([
        { type: 'configureBoard', id: 'board-5', patch: { launchCommand: 'claude', cwd: '/repo' } }
      ])
    })

    it('throws when the renderer rejects the command (no silent failure)', async () => {
      const orch = buildOrchestrator(
        reg([], [], {}, {}, {}, async () => ({ ok: false, error: 'no-window' }))
      )
      await expect(orch.configureBoard('b', { shell: 'pwsh' })).rejects.toThrow(/no-window/)
    })
  })

  describe('🔒 cap reconciliation + idle-reaping (T3.4, the M3 gate)', () => {
    // A registry whose mirror is mutated by the commands the adapter issues (so the
    // adapter's own spawns/closes show up in listBoards, like the real renderer).
    function liveReg(opts: { drained?: string[] } = {}): {
      registry: BoardRegistry
      boards: Array<{ id: string; type: string; title: string; status?: string }>
      setStatus: (id: string, status: string) => void
    } {
      const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
      const registry: BoardRegistry = {
        listBoards: () => boards,
        listSessions: () => [],
        readOutput: () => EMPTY_OUTPUT,
        readResult: () => EMPTY_RESULT,
        readMemory: () => EMPTY_MEMORY,
        readSummary: () => EMPTY_MEMORY,
        sendCommand: async (cmd) => {
          if (cmd.type === 'addBoard')
            boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T', status: 'running' })
          if (cmd.type === 'removeBoard') {
            const i = boards.findIndex((b) => b.id === cmd.id)
            if (i >= 0) boards.splice(i, 1)
          }
          return { ok: true, type: cmd.type }
        },
        drainPty: async (id) => {
          opts.drained?.push(id)
        }
      }
      const setStatus = (id: string, status: string): void => {
        const b = boards.find((x) => x.id === id)
        if (b) b.status = status
      }
      return { registry, boards, setStatus }
    }

    it('reconciles the cap against the live mirror — a vanished board frees a slot', async () => {
      let clock = 0
      const { registry, boards } = liveReg()
      const orch = buildOrchestrator(registry, { now: () => clock, cap: 2, spawnGraceMs: 1000 })
      await orch.spawnBoard({ type: 'terminal' })
      const b = await orch.spawnBoard({ type: 'terminal' })
      // At cap 2 (both within the spawn grace → not reconciled away) → reject.
      await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
      // The user manually closes board B (it leaves the mirror) and time passes the grace.
      const i = boards.findIndex((x) => x.id === b.id)
      boards.splice(i, 1)
      clock = 5000
      // Next spawn reconciles the vanished id out of the budget → a slot is free.
      await expect(orch.spawnBoard({ type: 'terminal' })).resolves.toHaveProperty('id')
    })

    it('reapIdle closes a spawned board idle past the TTL (and leaves running ones)', async () => {
      let clock = 0
      const drained: string[] = []
      const { registry, boards, setStatus } = liveReg({ drained })
      const orch = buildOrchestrator(registry, { now: () => clock, idleTtlMs: 1000 })
      const { id: idle } = await orch.spawnBoard({ type: 'terminal' })
      const { id: busy } = await orch.spawnBoard({ type: 'terminal' })
      setStatus(idle, 'idle')
      setStatus(busy, 'running')
      // Sweep 1 marks idleSince; nothing reaped yet.
      expect(await orch.reapIdle()).toEqual([])
      clock = 500
      expect(await orch.reapIdle()).toEqual([]) // still within the TTL
      clock = 1500 // idle for 1500ms >= ttl 1000
      const reaped = await orch.reapIdle()
      expect(reaped).toEqual([idle])
      expect(drained).toContain(idle) // it was gracefully closed (drained + removed)
      expect(boards.some((b) => b.id === idle)).toBe(false) // gone from the mirror
      expect(boards.some((b) => b.id === busy)).toBe(true) // the running board survives
    })

    it('a board that returns to running before the TTL is NOT reaped (idle clock resets)', async () => {
      let clock = 0
      const { registry, setStatus } = liveReg()
      const orch = buildOrchestrator(registry, { now: () => clock, idleTtlMs: 1000 })
      const { id } = await orch.spawnBoard({ type: 'terminal' })
      setStatus(id, 'idle')
      await orch.reapIdle() // marks idleSince=0
      clock = 800
      setStatus(id, 'running') // came back to life before the TTL
      await orch.reapIdle() // running → idle clock cleared
      clock = 1700
      setStatus(id, 'idle')
      expect(await orch.reapIdle()).toEqual([]) // idleSince re-armed at 1700, not yet past TTL
    })
  })
})

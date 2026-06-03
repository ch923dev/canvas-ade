import { describe, expect, it } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@ch923dev/canvas-ade-mcp'
import { buildOrchestrator, MCP_SPAWN_CAP, type BoardRegistry } from './mcpOrchestrator'
import type { McpCommand, McpCommandAck } from './mcpCommand'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

/** A sendCommand that always acks ok and records the commands it saw. */
function okCommands(): { sendCommand: BoardRegistry['sendCommand']; seen: McpCommand[] } {
  const seen: McpCommand[] = []
  return {
    seen,
    sendCommand: async (cmd) => {
      seen.push(cmd)
      return { ok: true, type: cmd.type }
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
  })
): BoardRegistry {
  return {
    listBoards: () => boards,
    listSessions: () => sessions,
    readOutput: (id) => outputs[id] ?? EMPTY_OUTPUT,
    readResult: (id) => resultsById[id] ?? EMPTY_RESULT,
    readMemory: () => memory.project ?? EMPTY_MEMORY,
    readSummary: (id) => memory.summaries?.[id] ?? EMPTY_MEMORY,
    sendCommand
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
      sendCommand: async (cmd) => ({ ok: true, type: cmd.type })
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
})

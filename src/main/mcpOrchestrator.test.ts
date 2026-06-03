import { describe, expect, it } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@ch923dev/canvas-ade-mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

function reg(
  boards: Array<{ id: string; type: string; title: string; status?: string }>,
  sessions: Array<{ id: string; status: string }> = [],
  outputs: Record<string, BoardOutput> = {},
  resultsById: Record<string, BoardResult> = {},
  memory: { project?: MemoryDoc; summaries?: Record<string, MemoryDoc> } = {}
): BoardRegistry {
  return {
    listBoards: () => boards,
    listSessions: () => sessions,
    readOutput: (id) => outputs[id] ?? EMPTY_OUTPUT,
    readResult: (id) => resultsById[id] ?? EMPTY_RESULT,
    readMemory: () => memory.project ?? EMPTY_MEMORY,
    readSummary: (id) => memory.summaries?.[id] ?? EMPTY_MEMORY
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
      readSummary: () => EMPTY_MEMORY
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

  it('spawnBoard / dispatchPrompt / gitDiff are phase-gated', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/Phase 3/)
    await expect(orch.dispatchPrompt('b', 'x')).rejects.toThrow(/Phase 4/)
    await expect(orch.gitDiff('b')).rejects.toThrow(/Phase 6/)
  })
})

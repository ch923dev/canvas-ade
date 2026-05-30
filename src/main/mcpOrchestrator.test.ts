import { describe, expect, it } from 'vitest'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'

function reg(
  boards: Array<{ id: string; type: string; title: string }>,
  sessions: Array<{ id: string; status: string }> = []
): BoardRegistry {
  return { listBoards: () => boards, listSessions: () => sessions }
}

describe('buildOrchestrator', () => {
  it('lists all board types with title + derived status', async () => {
    const orch = buildOrchestrator(
      reg(
        [
          { id: 't1', type: 'terminal', title: 'Term' },
          { id: 'b1', type: 'browser', title: 'Web' },
          { id: 'p1', type: 'planning', title: 'Plan' }
        ],
        [{ id: 't1', status: 'running' }]
      )
    )
    expect(await orch.listBoards()).toEqual([
      { id: 't1', type: 'terminal', title: 'Term', status: 'running' },
      { id: 'b1', type: 'browser', title: 'Web', status: 'open' },
      { id: 'p1', type: 'planning', title: 'Plan', status: 'static' }
    ])
  })

  it('a terminal board with no live PTY reads no-session', async () => {
    const orch = buildOrchestrator(reg([{ id: 't1', type: 'terminal', title: 'T' }]))
    expect(await orch.boardStatus('t1')).toBe('no-session')
  })

  it('boardStatus throws for an unknown board', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.boardStatus('nope')).rejects.toThrow(/not found/)
  })

  it('spawnBoard / dispatchPrompt / gitDiff are phase-gated', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/Phase 3/)
    await expect(orch.dispatchPrompt('b', 'x')).rejects.toThrow(/Phase 4/)
    await expect(orch.gitDiff('b')).rejects.toThrow(/Phase 6/)
  })
})

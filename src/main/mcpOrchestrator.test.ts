import { describe, expect, it } from 'vitest'
import { buildPtyOrchestrator, type BoardRegistry } from './mcpOrchestrator'

const registry = (sessions: Array<{ id: string; status: string }>): BoardRegistry => ({
  listSessions: () => sessions
})

describe('buildPtyOrchestrator', () => {
  it('maps PTY sessions to terminal board summaries', async () => {
    const orch = buildPtyOrchestrator(registry([{ id: 'b1', status: 'running' }]))
    expect(await orch.listBoards()).toEqual([{ id: 'b1', type: 'terminal', status: 'running' }])
  })

  it('boardStatus returns a known session status', async () => {
    const orch = buildPtyOrchestrator(registry([{ id: 'b1', status: 'exited' }]))
    expect(await orch.boardStatus('b1')).toBe('exited')
  })

  it('boardStatus throws for an unknown board', async () => {
    const orch = buildPtyOrchestrator(registry([]))
    await expect(orch.boardStatus('nope')).rejects.toThrow(/not found/)
  })

  it('spawnBoard / dispatchPrompt / gitDiff are phase-gated', async () => {
    const orch = buildPtyOrchestrator(registry([]))
    await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/Phase 3/)
    await expect(orch.dispatchPrompt('b1', 'hi')).rejects.toThrow(/Phase 4/)
    await expect(orch.gitDiff('b1')).rejects.toThrow(/Phase 6/)
  })
})

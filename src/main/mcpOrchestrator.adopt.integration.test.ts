import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoardResult, BoardStatusChange } from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import {
  subscribeBoardStatus,
  __applySnapshotForTest,
  __clearStatusListenersForTest
} from './boardRegistry'

const TERMINAL = (
  id: string,
  status: string
): { id: string; type: string; title: string; status: string } => ({
  id,
  type: 'terminal',
  title: id,
  status
})

/** A registry backed by the REAL board-status emitter + a seeded result store. */
function realStreamReg(results: Record<string, BoardResult>): BoardRegistry {
  return {
    listBoards: () => [],
    listSessions: () => [],
    readOutput: () => ({ text: '', total: 0, returned: 0, droppedOlder: false }),
    readResult: (id) => results[id] ?? { present: false },
    readMemory: () => ({ present: false, text: '' }),
    readSummary: () => ({ present: false, text: '' }),
    sendCommand: async (cmd) => ({ ok: true, type: cmd.type }),
    drainPty: async () => {},
    writeToPty: () => true,
    confirm: async () => ({ approved: true }),
    audit: async () => {},
    recordResult: () => {},
    listConnectors: () => [],
    // the REAL module-level emitter (PR1) — driven by __applySnapshotForTest below
    subscribeStatus: subscribeBoardStatus
  }
}

describe('M5 app-adopt: real boardRegistry emitter → adapter.subscribeStatus', () => {
  beforeEach(() => __clearStatusListenersForTest())
  afterEach(() => {
    __applySnapshotForTest([]) // reset the module mirror between tests
  })

  it('a running→idle snapshot apply surfaces idle + the recorded result via the adapter', () => {
    __applySnapshotForTest([]) // clean baseline (no prior boards)
    const orch = buildOrchestrator(
      realStreamReg({ t1: { present: true, status: 'success', summary: 'built' } })
    )
    const seen: BoardStatusChange[] = []
    const unsub = orch.subscribeStatus((c) => seen.push(c))

    __applySnapshotForTest([TERMINAL('t1', 'running')]) // appears running → emit
    __applySnapshotForTest([TERMINAL('t1', 'idle')]) // settles idle → emit + result

    unsub()
    expect(seen).toEqual([
      { id: 't1', status: 'running' },
      { id: 't1', status: 'idle', result: { present: true, status: 'success', summary: 'built' } }
    ])
  })

  it('a board leaving the canvas surfaces gone (presence signal, no result)', () => {
    __applySnapshotForTest([])
    const orch = buildOrchestrator(realStreamReg({}))
    const seen: BoardStatusChange[] = []
    const unsub = orch.subscribeStatus((c) => seen.push(c))

    __applySnapshotForTest([TERMINAL('t1', 'running')])
    __applySnapshotForTest([]) // t1 vanished → 'gone'

    unsub()
    expect(seen).toEqual([
      { id: 't1', status: 'running' },
      { id: 't1', status: 'gone' }
    ])
  })

  it('an idle board with no recorded result emits a bare idle change (no result key)', () => {
    const orch = buildOrchestrator(realStreamReg({})) // no seeded results
    const seen: BoardStatusChange[] = []
    const unsub = orch.subscribeStatus((c) => seen.push(c))

    __applySnapshotForTest([TERMINAL('t1', 'running')])
    __applySnapshotForTest([TERMINAL('t1', 'idle')]) // idle but readResult → { present: false } → no result

    unsub()
    expect(seen).toEqual([
      { id: 't1', status: 'running' },
      { id: 't1', status: 'idle' }
    ])
  })
})

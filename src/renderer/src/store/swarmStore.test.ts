import { beforeEach, describe, expect, it } from 'vitest'
import { runFor, useSwarmStore } from './swarmStore'

/**
 * swarmStore — MULTI-INSTANCE run state (orchestration S1). The load-bearing property is
 * per-board isolation: N swarm boards = N independent runs, so every assertion here drives
 * two runs and checks the other never moves (the no-state-bleed contract behind the
 * 2-board concurrent smoke).
 */
describe('swarmStore — per-board run isolation', () => {
  beforeEach(() => {
    useSwarmStore.getState().clearAll()
  })

  it('runFor on an absent run is REFERENCE-STABLE (zustand-selector contract — a fresh object per call loops useSyncExternalStore and error-bounds the board)', () => {
    const { runs } = useSwarmStore.getState()
    expect(runFor(runs, 'nope')).toBe(runFor(runs, 'nope'))
    expect(runFor(runs, 'nope')).toBe(runFor(runs, 'other-absent'))
    // The shared snapshot is frozen — any accidental mutation throws instead of bleeding state.
    expect(Object.isFrozen(runFor(runs, 'nope'))).toBe(true)
  })

  it('keeps two runs fully independent (messages, workers, pause)', () => {
    const s = useSwarmStore.getState()
    s.addUserMessage('a', 'run A goal')
    s.addUserMessage('b', 'run B goal')
    s.addWorker('a', 'w1', { role: 'builder' })
    s.setPaused('b', true)
    const a = runFor(useSwarmStore.getState().runs, 'a')
    const b = runFor(useSwarmStore.getState().runs, 'b')
    expect(a.messages.map((m) => m.text)).toEqual(['run A goal'])
    expect(b.messages.map((m) => m.text)).toEqual(['run B goal'])
    expect(a.workerIds).toEqual(['w1'])
    expect(b.workerIds).toEqual([])
    expect(a.paused).toBe(false)
    expect(b.paused).toBe(true)
  })

  it('streams an orch bubble: begin → deltas append → settle clears the streaming flag', () => {
    const s = useSwarmStore.getState()
    const id = s.beginOrchMessage('a')
    s.appendOrchDelta('a', id, 'Plan drawn — ')
    s.appendOrchDelta('a', id, '5 tasks.')
    let run = runFor(useSwarmStore.getState().runs, 'a')
    expect(run.messages[0]).toMatchObject({
      role: 'orch',
      text: 'Plan drawn — 5 tasks.',
      streaming: true
    })
    s.settleOrchMessage('a', id)
    run = runFor(useSwarmStore.getState().runs, 'a')
    expect(run.messages[0].streaming).toBeUndefined()
  })

  it('drops an empty settled bubble (error/cancel before any delta)', () => {
    const s = useSwarmStore.getState()
    const id = s.beginOrchMessage('a')
    s.settleOrchMessage('a', id)
    expect(runFor(useSwarmStore.getState().runs, 'a').messages).toEqual([])
  })

  it('stamps startedAt on the first message only', () => {
    const s = useSwarmStore.getState()
    s.addUserMessage('a', 'first')
    const t1 = runFor(useSwarmStore.getState().runs, 'a').startedAt
    expect(t1).not.toBeNull()
    s.addStatusLine('a', 'later')
    expect(runFor(useSwarmStore.getState().runs, 'a').startedAt).toBe(t1)
  })

  it('worker membership: add is idempotent, meta merges, remove drops both', () => {
    const s = useSwarmStore.getState()
    s.addWorker('a', 'w1', { role: 'builder' })
    s.addWorker('a', 'w1') // idempotent — no dup, meta kept
    s.setWorkerMeta('a', 'w1', { activity: 'Migrating…' })
    let run = runFor(useSwarmStore.getState().runs, 'a')
    expect(run.workerIds).toEqual(['w1'])
    expect(run.workerMeta.w1).toMatchObject({ role: 'builder', activity: 'Migrating…' })
    expect(run.workerMeta.w1.joinedAt).toBeTypeOf('number')
    s.removeWorker('a', 'w1')
    run = runFor(useSwarmStore.getState().runs, 'a')
    expect(run.workerIds).toEqual([])
    expect(run.workerMeta.w1).toBeUndefined()
  })

  it('removeRun drops only the one run; clearAll drops everything', () => {
    const s = useSwarmStore.getState()
    s.addUserMessage('a', 'x')
    s.addUserMessage('b', 'y')
    s.removeRun('a')
    expect(useSwarmStore.getState().runs.has('a')).toBe(false)
    expect(useSwarmStore.getState().runs.has('b')).toBe(true)
    s.clearAll()
    expect(useSwarmStore.getState().runs.size).toBe(0)
  })

  it('runFor returns the empty shape for an unknown board without creating it', () => {
    const run = runFor(useSwarmStore.getState().runs, 'ghost')
    expect(run.messages).toEqual([])
    expect(useSwarmStore.getState().runs.has('ghost')).toBe(false)
  })
})

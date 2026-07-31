import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRing, pushRing } from './ptyOutput'
import { startIdleMonitor, clearAwaitingInput, type IdleSession } from './ptyLifecycleMonitor'
import type { PtyLifecycleSignal } from './ptyLifecycle'

/**
 * The EVENT-DRIVEN idle monitor (audit R13 — replaced the always-on 2s scan). The contract
 * under test: pokes arm exactly one quiescence check per session, an early-firing check
 * lazily re-arms for the remainder, a quiet soliciting prompt flags + emits exactly once,
 * and an idle monitor with no live sessions holds ZERO pending timers.
 */

function makeSession(over?: Partial<IdleSession>): IdleSession & { posted: unknown[] } {
  const posted: unknown[] = []
  const s: IdleSession & { posted: unknown[] } = {
    state: 'running',
    lastActivityAt: Date.now(),
    buf: createRing(4096),
    port: { postMessage: (m: unknown) => void posted.push(m) },
    posted,
    ...over
  }
  return s
}

describe('startIdleMonitor (event-driven, R13)', () => {
  const IDLE = 10_000
  let emitted: PtyLifecycleSignal[]
  const emit = (sig: PtyLifecycleSignal): void => void emitted.push(sig)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    emitted = []
  })
  afterEach(() => vi.useRealTimers())

  function monitorOver(sessions: Map<string, IdleSession>) {
    return startIdleMonitor(
      (id) => sessions.get(id),
      () => sessions,
      () => '/proj',
      emit,
      { idleMs: IDLE }
    )
  }

  it('flags a quiet soliciting prompt once: awaiting-input posted + needs-input emitted', () => {
    const s = makeSession()
    pushRing(s.buf, 'Continue? ')
    const sessions = new Map([['b1', s]])
    const mon = monitorOver(sessions)
    mon.poke('b1')
    vi.advanceTimersByTime(IDLE)
    expect(s.awaitingInput).toBe(true)
    expect(s.posted).toEqual([{ t: 'state', state: 'awaiting-input' }])
    expect(emitted).toEqual([{ boardId: 'b1', event: 'needs-input', cwd: '/proj' }])
    // No re-arm after a flag: nothing further fires without a fresh poke.
    vi.advanceTimersByTime(IDLE * 10)
    expect(emitted).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    mon.dispose()
  })

  it('a check that fires early (output since arming) re-arms for the remainder', () => {
    const s = makeSession()
    pushRing(s.buf, 'building...')
    const sessions = new Map([['b1', s]])
    const mon = monitorOver(sessions)
    mon.poke('b1')
    // 6s in, more output lands: lastActivityAt moves, poke is a no-op (already armed).
    vi.advanceTimersByTime(6_000)
    vi.setSystemTime(1_006_000)
    s.lastActivityAt = Date.now()
    pushRing(s.buf, '\nContinue? ')
    mon.poke('b1')
    // Original check fires at t=10s, sees only 4s of silence, re-arms for 6s more.
    vi.advanceTimersByTime(4_000)
    expect(s.awaitingInput).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(6_000)
    expect(s.awaitingInput).toBe(true)
    expect(emitted).toHaveLength(1)
    mon.dispose()
  })

  it('poke is O(1) idempotent while armed — repeated pokes keep ONE pending timer', () => {
    const s = makeSession()
    const sessions = new Map([['b1', s]])
    const mon = monitorOver(sessions)
    for (let i = 0; i < 1000; i++) mon.poke('b1')
    expect(vi.getTimerCount()).toBe(1)
    mon.dispose()
  })

  it('a non-prompt quiet tail does NOT flag and does NOT re-arm (output will re-poke)', () => {
    const s = makeSession()
    pushRing(s.buf, 'user@host:~$ ')
    const sessions = new Map([['b1', s]])
    const mon = monitorOver(sessions)
    mon.poke('b1')
    vi.advanceTimersByTime(IDLE)
    expect(s.awaitingInput).toBeUndefined()
    expect(emitted).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    mon.dispose()
  })

  it('an orphaned check self-clears when the session is gone (no drop call needed)', () => {
    const sessions = new Map<string, IdleSession>([['b1', makeSession()]])
    const mon = monitorOver(sessions)
    mon.poke('b1')
    sessions.delete('b1')
    vi.advanceTimersByTime(IDLE)
    expect(emitted).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    mon.dispose()
  })

  it('drop cancels a pending check; dispose cancels everything', () => {
    const s1 = makeSession()
    const s2 = makeSession()
    const sessions = new Map([
      ['b1', s1],
      ['b2', s2]
    ])
    const mon = monitorOver(sessions)
    mon.poke('b1')
    mon.poke('b2')
    expect(vi.getTimerCount()).toBe(2)
    mon.drop('b1')
    expect(vi.getTimerCount()).toBe(1)
    mon.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(IDLE * 2)
    expect(emitted).toHaveLength(0)
  })

  it('sweeps sessions alive at wiring time (adopted-across-restart may never output again)', () => {
    const s = makeSession()
    pushRing(s.buf, 'Password:')
    const sessions = new Map([['pre', s]])
    const mon = monitorOver(sessions)
    // No poke — the constructor's initial sweep must have armed it.
    vi.advanceTimersByTime(IDLE)
    expect(s.awaitingInput).toBe(true)
    expect(emitted).toEqual([{ boardId: 'pre', event: 'needs-input', cwd: '/proj' }])
    mon.dispose()
  })

  it('clearAwaitingInput + a fresh poke lets a NEW idle period fire again', () => {
    const s = makeSession()
    pushRing(s.buf, 'Continue? ')
    const sessions = new Map([['b1', s]])
    const mon = monitorOver(sessions)
    mon.poke('b1')
    vi.advanceTimersByTime(IDLE)
    expect(emitted).toHaveLength(1)
    // User answers; output arrives: pty.ts clears the flag, bumps activity, pokes.
    vi.setSystemTime(Date.now())
    clearAwaitingInput(s)
    s.lastActivityAt = Date.now()
    pushRing(s.buf, '\nOverwrite existing file? ')
    mon.poke('b1')
    vi.advanceTimersByTime(IDLE)
    expect(emitted).toHaveLength(2)
    expect(s.posted).toEqual([
      { t: 'state', state: 'awaiting-input' },
      { t: 'state', state: 'running' },
      { t: 'state', state: 'awaiting-input' }
    ])
    mon.dispose()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useSwitchTransitionStore,
  armSwitchTransition,
  settleSwitchTransitionIn,
  clearSwitchTransition,
  SWITCH_OUT_MS,
  SWITCH_IN_MS,
  SWITCH_REDUCED_MS,
  SWITCH_IN_CLEAR_BUFFER_MS,
  SWITCH_WATCHDOG_MS
} from './switchTransitionStore'

// Phase-machine timing (Phase 4c) — fake timers drive the OUT/HOLD/IN/clear schedule.
const ARM = {
  snapshotUrl: 'data:image/png;base64,AAAA',
  incomingName: 'beta',
  outgoingName: 'alpha'
}

const phase = (): string => useSwitchTransitionStore.getState().phase

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  clearSwitchTransition()
  vi.useRealTimers()
})

describe('switchTransitionStore phase machine', () => {
  it('arm → OUT, then HOLD when the load has not settled at OUT end', () => {
    armSwitchTransition(ARM)
    expect(useSwitchTransitionStore.getState()).toMatchObject({ ...ARM, phase: 'out' })
    vi.advanceTimersByTime(SWITCH_OUT_MS)
    expect(phase()).toBe('hold')
  })

  it('a settle DURING OUT queues IN behind the completing OUT (HOLD never shows)', () => {
    armSwitchTransition(ARM)
    settleSwitchTransitionIn()
    expect(phase()).toBe('out') // IN must not start before OUT completes
    vi.advanceTimersByTime(SWITCH_OUT_MS)
    expect(phase()).toBe('in')
    vi.advanceTimersByTime(SWITCH_IN_MS + SWITCH_IN_CLEAR_BUFFER_MS)
    expect(useSwitchTransitionStore.getState()).toMatchObject({
      phase: 'idle',
      snapshotUrl: null,
      incomingName: null,
      outgoingName: null
    })
  })

  it('a settle from HOLD enters IN immediately, then self-clears', () => {
    armSwitchTransition(ARM)
    vi.advanceTimersByTime(SWITCH_OUT_MS)
    expect(phase()).toBe('hold')
    settleSwitchTransitionIn()
    expect(phase()).toBe('in')
    vi.advanceTimersByTime(SWITCH_IN_MS + SWITCH_IN_CLEAR_BUFFER_MS)
    expect(phase()).toBe('idle')
  })

  it('a missing snapshot skips OUT — straight to HOLD (fade path, never a blocked switch)', () => {
    armSwitchTransition({ ...ARM, snapshotUrl: null })
    expect(phase()).toBe('hold')
    settleSwitchTransitionIn()
    expect(phase()).toBe('in')
  })

  it('watchdog force-clears a hung load; a post-clear settle is a no-op', () => {
    armSwitchTransition(ARM)
    vi.advanceTimersByTime(SWITCH_WATCHDOG_MS)
    expect(phase()).toBe('idle')
    settleSwitchTransitionIn()
    expect(phase()).toBe('idle')
  })

  it('the watchdog is disarmed once IN starts (a long IN tail is not force-cleared twice)', () => {
    armSwitchTransition(ARM)
    vi.advanceTimersByTime(SWITCH_OUT_MS)
    settleSwitchTransitionIn()
    expect(phase()).toBe('in')
    // Advance past the original watchdog deadline in steps smaller than the IN clear —
    // only the IN timer should fire, taking the store to idle exactly once.
    vi.advanceTimersByTime(SWITCH_IN_MS + SWITCH_IN_CLEAR_BUFFER_MS)
    expect(phase()).toBe('idle')
    vi.advanceTimersByTime(SWITCH_WATCHDOG_MS)
    expect(phase()).toBe('idle')
  })

  it('clear drops the overlay NOW and cancels every pending timer', () => {
    armSwitchTransition(ARM)
    clearSwitchTransition()
    expect(phase()).toBe('idle')
    vi.advanceTimersByTime(SWITCH_WATCHDOG_MS * 2)
    expect(phase()).toBe('idle') // no phantom OUT/watchdog timer resurrects a phase
  })

  it('re-arm while armed restarts the machine fresh (stale timers cancelled)', () => {
    armSwitchTransition(ARM)
    vi.advanceTimersByTime(SWITCH_OUT_MS - 10)
    armSwitchTransition({ ...ARM, incomingName: 'gamma' })
    expect(useSwitchTransitionStore.getState().incomingName).toBe('gamma')
    // The FIRST arm's OUT timer (10ms out) must not flip the fresh OUT to HOLD early.
    vi.advanceTimersByTime(10)
    expect(phase()).toBe('out')
    vi.advanceTimersByTime(SWITCH_OUT_MS - 10)
    expect(phase()).toBe('hold')
  })

  it('settle when idle is a no-op (welcome-screen opens never arm)', () => {
    settleSwitchTransitionIn()
    expect(phase()).toBe('idle')
  })

  it('reduced motion: sampled at arm, swaps both legs to the 120ms fade timings', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true })
    })
    try {
      armSwitchTransition(ARM)
      expect(useSwitchTransitionStore.getState().reduced).toBe(true)
      vi.advanceTimersByTime(SWITCH_REDUCED_MS)
      expect(phase()).toBe('hold')
      settleSwitchTransitionIn()
      vi.advanceTimersByTime(SWITCH_REDUCED_MS + SWITCH_IN_CLEAR_BUFFER_MS)
      expect(phase()).toBe('idle')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// @vitest-environment jsdom
/**
 * PR #355 review: the reconcile() start() continuation is generation-guarded (the
 * MIC-1-class hot-mic seam). A STALE start settling {ok:false} must not clobber
 * `listening` for a newer, live start — pre-fix that clobber made a later disable
 * early-return out of reconcile() without ever calling stop(), leaving the newer
 * wake capture running with no indicator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { useWakeWord } from './useWakeWord'
import { useJarvisStore } from '../store/jarvisStore'

type WakeCfg = { enabled: boolean; wakeWordEnabled: boolean }

let startResolvers: Array<{ resolve: (r: { ok: boolean }) => void; reject: (e: Error) => void }>
let start: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
let cfgListener: ((cfg: WakeCfg) => void) | undefined

beforeEach(() => {
  startResolvers = []
  start = vi.fn(
    () =>
      new Promise<{ ok: boolean }>((resolve, reject) => {
        startResolvers.push({ resolve, reject })
      })
  )
  stop = vi.fn(async () => {})
  cfgListener = undefined
  useJarvisStore.setState({ panelOpen: false })
  window.api = {
    jarvis: {
      config: {
        get: async (): Promise<WakeCfg> => ({ enabled: true, wakeWordEnabled: true }),
        onChanged: (cb: (cfg: WakeCfg) => void): (() => void) => {
          cfgListener = cb
          return () => {}
        }
      }
    },
    voice: {
      supported: true,
      wake: { start, stop, onEvent: (): (() => void) => () => {} },
      config: { get: async (): Promise<{ micDeviceId?: string }> => ({}) }
    }
  } as never
})
afterEach(() => {
  cleanup()
})

describe('useWakeWord reconcile generation guard', () => {
  it('a stale start settling {ok:false} does not clobber a newer start — disable still stops', async () => {
    renderHook(() => useWakeWord())
    // Initial config lands → reconcile → start A in flight.
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    // The documented off→on re-arm gesture while A is STILL in flight.
    act(() => cfgListener!({ enabled: true, wakeWordEnabled: false }))
    expect(stop).toHaveBeenCalledTimes(1)
    act(() => cfgListener!({ enabled: true, wakeWordEnabled: true }))
    expect(start).toHaveBeenCalledTimes(2) // B in flight (the live one)

    // STALE A finally settles refused — must be ignored (generation mismatch).
    await act(async () => {
      startResolvers[0].resolve({ ok: false })
    })

    // Disabling now MUST reach stop(): pre-fix the stale settle had already flipped
    // `listening` false, reconcile early-returned, and B's capture stayed live.
    act(() => cfgListener!({ enabled: true, wakeWordEnabled: false }))
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('a stale start REJECTING does not clobber a newer start either', async () => {
    renderHook(() => useWakeWord())
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    act(() => cfgListener!({ enabled: true, wakeWordEnabled: false }))
    act(() => cfgListener!({ enabled: true, wakeWordEnabled: true }))
    expect(start).toHaveBeenCalledTimes(2)

    await act(async () => {
      startResolvers[0].reject(new Error('superseded'))
    })

    act(() => cfgListener!({ enabled: true, wakeWordEnabled: false }))
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('a CURRENT start settling {ok:false} still stands down (model absent path intact)', async () => {
    renderHook(() => useWakeWord())
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    await act(async () => {
      startResolvers[0].resolve({ ok: false })
    })

    // Stood down: a fresh re-arm gesture re-attempts (listening was truly cleared).
    act(() => cfgListener!({ enabled: true, wakeWordEnabled: true }))
    expect(start).toHaveBeenCalledTimes(2)
  })
})

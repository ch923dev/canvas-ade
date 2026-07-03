// @vitest-environment jsdom
/**
 * F4: the Inspector hook-health fault. Pins the fail-quiet contract (null on MAIN-null and on
 * IPC failure), the fault priority (runner > hook > no-capture), and the no-capture grace —
 * the fault only fires for a RUNNING Claude board, only after the 15s grace, and only off a
 * post-grace re-read (a capture landing mid-grace clears it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { useHookHealth, isClaudeLaunch, NO_CAPTURE_GRACE_MS } from './useHookHealth'
import type { TerminalBoard } from '../../../lib/boardSchema'

const health = vi.fn()
beforeEach(() => {
  health.mockReset()
  window.api = { recap: { health } } as never
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const board = (over: Partial<TerminalBoard> = {}): TerminalBoard =>
  ({
    id: 't1',
    type: 'terminal',
    title: 't',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    launchCommand: 'claude',
    ...over
  }) as TerminalBoard

describe('useHookHealth', () => {
  it('null when MAIN returns null (no project / consent off) and on IPC failure', async () => {
    health.mockResolvedValue(null)
    const a = renderHook(() => useHookHealth(board(), 'exited'))
    await waitFor(() => expect(health).toHaveBeenCalled())
    expect(a.result.current).toBeNull()

    health.mockRejectedValue(new Error('ipc dead'))
    const b = renderHook(() => useHookHealth(board(), 'exited'))
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2))
    expect(b.result.current).toBeNull()
  })

  it('healthy payload renders nothing (zero added chrome)', async () => {
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: true,
      captured: true,
      sessionAgeMs: null
    })
    const { result } = renderHook(() => useHookHealth(board(), 'exited'))
    await waitFor(() => expect(health).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it("runner missing wins over everything — it's why the hook could never install", async () => {
    health.mockResolvedValue({
      runner: 'missing',
      hookInstalled: false,
      captured: false,
      sessionAgeMs: null
    })
    const { result } = renderHook(() => useHookHealth(board(), 'exited'))
    await waitFor(() => expect(result.current).toBe('runner'))
  })

  it('hook-not-installed (the settings clobber) reports when the runner is fine', async () => {
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: false,
      captured: true,
      sessionAgeMs: null
    })
    const { result } = renderHook(() => useHookHealth(board(), 'exited'))
    await waitFor(() => expect(result.current).toBe('hook'))
  })

  it('no-capture fires only after the grace, from a post-grace re-read', async () => {
    vi.useFakeTimers()
    // Spawn-time snapshot: young session, uncaptured — no fault yet.
    health.mockResolvedValueOnce({
      runner: 'ok',
      hookInstalled: true,
      captured: false,
      sessionAgeMs: 100
    })
    // The post-grace re-read: still uncaptured, session now past the grace.
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: true,
      captured: false,
      sessionAgeMs: NO_CAPTURE_GRACE_MS + 600
    })
    const { result } = renderHook(() => useHookHealth(board(), 'running'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0) // initial query lands
    })
    expect(result.current).toBeNull() // uncaptured but the grace has not elapsed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NO_CAPTURE_GRACE_MS + 1000)
    })
    expect(result.current).toBe('no-capture')
    expect(health).toHaveBeenCalledTimes(2) // spawn-time snapshot + the post-grace re-read
  })

  it('a capture landing mid-grace clears it: the post-grace re-read sees captured=true', async () => {
    vi.useFakeTimers()
    health.mockResolvedValueOnce({
      runner: 'ok',
      hookInstalled: true,
      captured: false,
      sessionAgeMs: 100
    })
    const { result } = renderHook(() => useHookHealth(board(), 'running'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: true,
      captured: true,
      sessionAgeMs: NO_CAPTURE_GRACE_MS + 600
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NO_CAPTURE_GRACE_MS + 1000)
    })
    expect(result.current).toBeNull()
  })

  it('no-capture never fires for a non-Claude board or a non-running state', async () => {
    vi.useFakeTimers()
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: true,
      captured: false,
      sessionAgeMs: NO_CAPTURE_GRACE_MS + 600
    })
    const shell = renderHook(() =>
      useHookHealth(board({ launchCommand: undefined, agentKind: 'shell' }), 'running')
    )
    const exited = renderHook(() => useHookHealth(board(), 'exited'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NO_CAPTURE_GRACE_MS + 1000)
    })
    expect(shell.result.current).toBeNull()
    expect(exited.result.current).toBeNull()
  })

  it('window focus re-queries after the heal delay (the clobber line clears on alt-tab back)', async () => {
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: false,
      captured: true,
      sessionAgeMs: null
    })
    const { result } = renderHook(() => useHookHealth(board(), 'exited'))
    await waitFor(() => expect(result.current).toBe('hook'))

    vi.useFakeTimers()
    health.mockResolvedValue({
      runner: 'ok',
      hookInstalled: true,
      captured: true,
      sessionAgeMs: null
    })
    window.dispatchEvent(new Event('focus'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(result.current).toBeNull()
  })
})

describe('isClaudeLaunch', () => {
  it('trusts agentKind when present, else falls back to a claude launchCommand match', () => {
    expect(isClaudeLaunch({ agentKind: 'claude', launchCommand: undefined })).toBe(true)
    expect(isClaudeLaunch({ agentKind: 'shell', launchCommand: 'claude' })).toBe(false)
    expect(isClaudeLaunch({ agentKind: undefined, launchCommand: 'claude --continue' })).toBe(true)
    expect(isClaudeLaunch({ agentKind: undefined, launchCommand: 'npm run dev' })).toBe(false)
    expect(isClaudeLaunch({ agentKind: undefined, launchCommand: undefined })).toBe(false)
  })
})

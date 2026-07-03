// @vitest-environment jsdom
/**
 * F1: the MAIN-validated canResume gate. Pins the fail-closed contract — false until MAIN
 * confirms, false on IPC failure, no call at all without a stored id — and the re-validation
 * on PTY lifecycle flips (skipping the transient 'spawning' state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { useResumeValidity } from './useResumeValidity'
import { useResumeValidityStore } from '../../../store/resumeValidityStore'
import type { TerminalBoard } from '../../../lib/boardSchema'
import type { TerminalState } from '../terminalState'

const resumeCheck = vi.fn()
beforeEach(() => {
  resumeCheck.mockReset()
  window.api = { terminal: { resumeCheck } } as never
  useResumeValidityStore.setState({ validity: {} })
})
afterEach(cleanup)

const board = (over: Partial<TerminalBoard> = {}): TerminalBoard =>
  ({
    id: 't1',
    type: 'terminal',
    title: 't',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    agentSessionId: 'aaaabbbb-1111-2222-3333-444455556666',
    agentTranscriptPath: 'C:/claude/t.jsonl',
    ...over
  }) as TerminalBoard

describe('useResumeValidity', () => {
  it('false without a stored session id — and MAIN is never asked', () => {
    const { result } = renderHook(() =>
      useResumeValidity(board({ agentSessionId: undefined }), 'exited')
    )
    expect(result.current).toBe(false)
    expect(resumeCheck).not.toHaveBeenCalled()
  })

  it('flips true only after MAIN confirms the transcript is real', async () => {
    resumeCheck.mockResolvedValue({ canResume: true })
    const { result } = renderHook(() => useResumeValidity(board(), 'exited'))
    expect(result.current).toBe(false) // fail-closed until the round-trip lands
    await waitFor(() => expect(result.current).toBe(true))
    expect(resumeCheck).toHaveBeenCalledWith('t1', {
      sessionId: 'aaaabbbb-1111-2222-3333-444455556666',
      transcriptPath: 'C:/claude/t.jsonl'
    })
  })

  it('stays false when MAIN refutes or the IPC fails (fail-closed)', async () => {
    resumeCheck.mockResolvedValue({ canResume: false })
    const a = renderHook(() => useResumeValidity(board(), 'exited'))
    await waitFor(() => expect(resumeCheck).toHaveBeenCalled())
    expect(a.result.current).toBe(false)

    resumeCheck.mockRejectedValue(new Error('ipc dead'))
    const b = renderHook(() => useResumeValidity(board(), 'exited'))
    await waitFor(() => expect(resumeCheck).toHaveBeenCalledTimes(2))
    expect(b.result.current).toBe(false)
  })

  it('re-validates on a lifecycle flip, skipping the transient spawning state', async () => {
    resumeCheck.mockResolvedValue({ canResume: true })
    const { result, rerender } = renderHook(
      ({ s }: { s: TerminalState }) => useResumeValidity(board(), s),
      { initialProps: { s: 'spawning' as TerminalState } }
    )
    expect(resumeCheck).not.toHaveBeenCalled() // spawning → answer would be stale in ms
    rerender({ s: 'exited' })
    await waitFor(() => expect(result.current).toBe(true))
    // A dead session pruned between exits: the next flip re-asks and flips back off.
    resumeCheck.mockResolvedValue({ canResume: false })
    rerender({ s: 'running' })
    await waitFor(() => expect(result.current).toBe(false))
    expect(resumeCheck).toHaveBeenCalledTimes(2)
  })

  // F1b: the hook is also the PUBLISHER for synchronous consumers (the palette snapshot).
  it('publishes each verdict to resumeValidityStore and clears it on unmount', async () => {
    resumeCheck.mockResolvedValue({ canResume: true })
    const { result, unmount } = renderHook(() => useResumeValidity(board(), 'exited'))
    await waitFor(() => expect(result.current).toBe(true))
    expect(useResumeValidityStore.getState().validity['t1']).toBe(true)
    unmount()
    // A stale `true` for a removed board must not linger for the palette to read.
    expect('t1' in useResumeValidityStore.getState().validity).toBe(false)
  })

  it('publishes the fail-closed false too (no stored id → store says false)', () => {
    renderHook(() => useResumeValidity(board({ agentSessionId: undefined }), 'exited'))
    expect(useResumeValidityStore.getState().validity['t1']).toBe(false)
  })
})

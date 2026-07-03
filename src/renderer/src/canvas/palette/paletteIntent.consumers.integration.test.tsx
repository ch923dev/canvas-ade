// @vitest-environment jsdom
/**
 * Palette intent consumers (D4-A): the one-shot intent channel must reach the
 * components that own the verb implementations — BoardFrame's inline title edit
 * (rename) and the terminal spawn hook's restart (via usePaletteRestart). Pins the
 * by-id targeting, the consume-once semantics, and the resume/new launch override.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, renderHook } from '@testing-library/react'
import { useRef, type MutableRefObject } from 'react'
import { BoardFrame } from '../BoardFrame'
import { useCanvasStore } from '../../store/canvasStore'
import { useToastStore } from '../../store/toastStore'
import { sendPaletteIntent, usePaletteIntentStore } from './paletteIntentStore'
import { usePaletteRestart } from '../boards/terminal/usePaletteRestart'

afterEach(cleanup)
beforeEach(() => {
  usePaletteIntentStore.setState({ intent: null })
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null, selectedIds: [] })
  useToastStore.setState({ toasts: [] })
})

const toastMessages = (): string[] => useToastStore.getState().toasts.map((t) => t.message)

describe('rename intent → BoardFrame title edit', () => {
  it('opens the editor on the matching board only, and consumes the intent', () => {
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useCanvasStore.getState().updateBoard(id, { title: 'agent' })
    render(
      <>
        <BoardFrame type="terminal" boardId={id} title="agent" />
        <BoardFrame type="planning" boardId="other" title="plan" />
      </>
    )
    expect(screen.queryByLabelText('Board title')).toBeNull()
    act(() => sendPaletteIntent(id, 'rename'))
    const inputs = screen.getAllByLabelText('Board title')
    expect(inputs).toHaveLength(1) // only the targeted board swapped to an input
    expect((inputs[0] as HTMLInputElement).value).toBe('agent')
    expect(usePaletteIntentStore.getState().intent).toBeNull() // consumed
  })

  it('ignores restart intents (wrong kind for this consumer)', () => {
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    render(<BoardFrame type="terminal" boardId={id} title="t" />)
    act(() => sendPaletteIntent(id, 'restart-new'))
    expect(screen.queryByLabelText('Board title')).toBeNull()
    // Left for the terminal consumer — NOT consumed by BoardFrame.
    expect(usePaletteIntentStore.getState().intent?.kind).toBe('restart-new')
  })
})

describe('restart intents → usePaletteRestart', () => {
  const resumeLaunch = vi.fn()
  beforeEach(() => {
    resumeLaunch.mockReset()
    window.api = { terminal: { resumeLaunch } } as never
  })

  function mount(
    boardId: string,
    agentSessionId?: string,
    agentTranscriptPath?: string
  ): {
    restart: ReturnType<typeof vi.fn>
    ref: MutableRefObject<string | undefined>
  } {
    const restart = vi.fn()
    const { result } = renderHook(() => {
      const ref = useRef<string | undefined>(undefined)
      usePaletteRestart(boardId, agentSessionId, agentTranscriptPath, ref, restart)
      return ref
    })
    return { restart, ref: result.current }
  }

  it('resume: writes the MAIN-resolved launch line and restarts (F3)', async () => {
    resumeLaunch.mockResolvedValue({ mode: 'resume', command: 'claude --resume sess-42' })
    const { restart, ref } = mount('t1', 'sess-42', 'C:/t.jsonl')
    await act(async () => sendPaletteIntent('t1', 'restart-resume'))
    expect(resumeLaunch).toHaveBeenCalledWith('t1', {
      sessionId: 'sess-42',
      transcriptPath: 'C:/t.jsonl'
    })
    expect(ref.current).toBe('claude --resume sess-42')
    expect(restart).toHaveBeenCalledTimes(1)
    expect(usePaletteIntentStore.getState().intent).toBeNull()
    expect(toastMessages()).toEqual([]) // a real resume degrades nothing — no toast
  })

  it('resume with a dead session → MAIN says fresh → override cleared, still restarts, toast names the degrade', async () => {
    resumeLaunch.mockResolvedValue({ mode: 'fresh' })
    const { restart, ref } = mount('t1', 'sess-42')
    ref.current = 'stale'
    await act(async () => sendPaletteIntent('t1', 'restart-resume'))
    expect(ref.current).toBeUndefined()
    expect(restart).toHaveBeenCalledTimes(1)
    // F1b: the user picked Resume and got a fresh start — that must not be silent.
    expect(toastMessages()).toEqual(['Session not resumable — started fresh'])
  })

  it('continue mode (cwd fallback) IS a resume — no fallback toast', async () => {
    resumeLaunch.mockResolvedValue({ mode: 'continue', command: 'claude --continue' })
    const { restart, ref } = mount('t1', 'sess-42')
    await act(async () => sendPaletteIntent('t1', 'restart-resume'))
    expect(ref.current).toBe('claude --continue')
    expect(restart).toHaveBeenCalledTimes(1)
    expect(toastMessages()).toEqual([])
  })

  it('resume IPC failure → falls back to fresh (never a stale renderer-side guess) + toast', async () => {
    resumeLaunch.mockRejectedValue(new Error('ipc dead'))
    const { restart, ref } = mount('t1', 'sess-42')
    ref.current = 'stale'
    await act(async () => sendPaletteIntent('t1', 'restart-resume'))
    expect(ref.current).toBeUndefined()
    expect(restart).toHaveBeenCalledTimes(1)
    expect(toastMessages()).toEqual(['Session not resumable — started fresh'])
  })

  it('new: clears the override without touching MAIN; other boards are ignored', async () => {
    const { restart, ref } = mount('t1', 'sess-42')
    ref.current = 'stale'
    await act(async () => sendPaletteIntent('t2', 'restart-new'))
    expect(restart).not.toHaveBeenCalled()
    await act(async () => sendPaletteIntent('t1', 'restart-new'))
    expect(ref.current).toBeUndefined()
    expect(restart).toHaveBeenCalledTimes(1)
    expect(resumeLaunch).not.toHaveBeenCalled()
  })
})

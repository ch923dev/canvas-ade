// @vitest-environment jsdom
/**
 * Voice V3 — flyout behavior against a mocked terminalInputRegistry (plan §V3 tests).
 * The load-bearing assertions: Send delivers the EXACT text via paste and then ONE
 * discrete `\r` via submit after the settle (never `text + '\r'` in a single write);
 * Insert never submits; the draft survives retarget/board-delete; buttons gate on the
 * live-PTY flag re-checked at submit-fire time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, configure } from '@testing-library/react'

// The app's probe attribute is `data-test` (e2e + these units share the selectors).
configure({ testIdAttribute: 'data-test' })
import { VoiceFlyout, injectTranscript, SUBMIT_SETTLE_MS } from './VoiceFlyout'
import { useVoiceStore } from '../store/voiceStore'
import { useCanvasStore } from '../store/canvasStore'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import {
  registerTerminalInput,
  unregisterTerminalInput
} from '../canvas/boards/terminal/terminalInputRegistry'

const ANCHOR = { x: 200, y: 500 }

const board = (id: string, title: string): never =>
  ({ id, type: 'terminal', title, x: 0, y: 0, w: 520, h: 320 }) as never

function seedTarget(
  id = 't1',
  title = 'claude — pwsh'
): { paste: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> } {
  useCanvasStore.setState({ boards: [board(id, title)], selectedId: id } as never)
  useTerminalRuntimeStore.setState({ running: { [id]: true } })
  const entry = { paste: vi.fn(), submit: vi.fn() }
  registerTerminalInput(id, entry)
  return entry
}

beforeEach(() => {
  useVoiceStore.setState({
    capturing: false,
    micSilent: false,
    micStatus: 'granted',
    modelStatus: 'ready',
    engineError: false,
    draft: '',
    partial: '',
    flyoutOpen: true
  })
  useCanvasStore.setState({ boards: [], selectedId: null } as never)
  useTerminalRuntimeStore.setState({ running: {} })
})

afterEach(() => {
  cleanup()
  unregisterTerminalInput('t1')
  unregisterTerminalInput('t2')
  vi.useRealTimers()
})

describe('VoiceFlyout — Send / Insert injection contract', () => {
  it('Send pastes the exact multi-line text, then ONE discrete \\r after the settle', async () => {
    vi.useFakeTimers()
    const entry = seedTarget()
    useVoiceStore.setState({ draft: 'line one\nline two' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.click(screen.getByTitle(/Paste \+ submit/))
    await act(async () => {}) // flush the injectTranscript microtask
    expect(entry.paste).toHaveBeenCalledTimes(1)
    expect(entry.paste).toHaveBeenCalledWith('line one\nline two') // exact bytes, no \r inside
    expect(entry.submit).not.toHaveBeenCalled() // not yet — the settle separates the writes
    act(() => void vi.advanceTimersByTime(SUBMIT_SETTLE_MS + 10))
    expect(entry.submit).toHaveBeenCalledTimes(1)
    // Consumed: draft cleared + flyout closed.
    expect(useVoiceStore.getState().draft).toBe('')
    expect(useVoiceStore.getState().flyoutOpen).toBe(false)
  })

  it('Insert pastes only — no submit ever fires', async () => {
    vi.useFakeTimers()
    const entry = seedTarget()
    useVoiceStore.setState({ draft: 'insert me' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.click(screen.getByTitle(/without submitting/))
    await act(async () => {})
    expect(entry.paste).toHaveBeenCalledWith('insert me')
    act(() => void vi.advanceTimersByTime(5000))
    expect(entry.submit).not.toHaveBeenCalled()
  })

  it('Send folds a provisional tail in with the draft (what the user saw is what lands)', async () => {
    const entry = seedTarget()
    useVoiceStore.setState({ draft: 'solid part', partial: 'tail part' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.click(screen.getByTitle(/Paste \+ submit/))
    await act(async () => {})
    expect(entry.paste).toHaveBeenCalledWith('solid part tail part')
  })

  it('submit re-checks running at fire time — a PTY death during the settle cancels the \\r', async () => {
    vi.useFakeTimers()
    const entry = seedTarget()
    useVoiceStore.setState({ draft: 'doomed' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.click(screen.getByTitle(/Paste \+ submit/))
    await act(async () => {})
    expect(entry.paste).toHaveBeenCalledTimes(1)
    useTerminalRuntimeStore.setState({ running: { t1: false } }) // dies mid-settle
    act(() => void vi.advanceTimersByTime(SUBMIT_SETTLE_MS + 10))
    expect(entry.submit).not.toHaveBeenCalled()
  })

  it('injectTranscript refuses outright when the target PTY is not running', async () => {
    const entry = seedTarget()
    useTerminalRuntimeStore.setState({ running: { t1: false } })
    useVoiceStore.setState({ draft: 'nope' })
    expect(await injectTranscript('t1', true)).toBe(false)
    expect(entry.paste).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().draft).toBe('nope') // draft kept
  })

  it('Enter sends; Shift+Enter and mid-IME Enter do not', async () => {
    vi.useFakeTimers()
    const entry = seedTarget()
    useVoiceStore.setState({ draft: 'via enter' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    const ta = screen.getByTestId('voice-flyout-input')
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true })
    expect(entry.paste).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: 'Enter' })
    await act(async () => {})
    expect(entry.paste).toHaveBeenCalledWith('via enter')
    act(() => void vi.advanceTimersByTime(SUBMIT_SETTLE_MS + 10))
    expect(entry.submit).toHaveBeenCalledTimes(1)
  })

  it('buttons are disabled without a running target', () => {
    seedTarget()
    useTerminalRuntimeStore.setState({ running: { t1: false } })
    useVoiceStore.setState({ draft: 'text present' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    expect((screen.getByTestId('voice-flyout-send') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('voice-flyout-insert') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('voice-flyout-notarget')).toBeTruthy()
  })
})

describe('VoiceFlyout — targeting + draft preservation', () => {
  it('retarget on selection change updates the header and keeps the draft', () => {
    seedTarget('t1', 'first term')
    useCanvasStore.setState({
      boards: [board('t1', 'first term'), board('t2', 'second term')],
      selectedId: 't1'
    } as never)
    useTerminalRuntimeStore.setState({ running: { t1: true, t2: true } })
    useVoiceStore.setState({ draft: 'keep me' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    expect(screen.getByTestId('voice-flyout-target').textContent).toContain('first term')
    act(() => useCanvasStore.setState({ selectedId: 't2' } as never))
    expect(screen.getByTestId('voice-flyout-target').textContent).toContain('second term')
    expect(useVoiceStore.getState().draft).toBe('keep me')
    expect((screen.getByTestId('voice-flyout-input') as HTMLTextAreaElement).value).toBe('keep me')
  })

  it('board delete drops to no-target but the draft survives', () => {
    seedTarget()
    useVoiceStore.setState({ draft: 'survivor' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    act(() => {
      useCanvasStore.setState({ boards: [], selectedId: null } as never)
      useTerminalRuntimeStore.setState({ running: {} })
    })
    expect(screen.getByTestId('voice-flyout-notarget')).toBeTruthy()
    expect(useVoiceStore.getState().draft).toBe('survivor')
  })

  it('Esc closes (draft kept) when not capturing', () => {
    seedTarget()
    useVoiceStore.setState({ draft: 'kept on esc' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.keyDown(screen.getByTestId('voice-flyout-input'), { key: 'Escape' })
    expect(useVoiceStore.getState().flyoutOpen).toBe(false)
    expect(useVoiceStore.getState().draft).toBe('kept on esc')
  })

  it('Esc stops listening first when capturing', () => {
    const stop = vi.fn().mockResolvedValue({ ok: true, frames: 0 })
    ;(window as never as { api: unknown }).api = { voice: { stop } }
    seedTarget()
    useVoiceStore.setState({ draft: 'x', capturing: true })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.keyDown(screen.getByTestId('voice-flyout-input'), { key: 'Escape' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().flyoutOpen).toBe(true) // still open — second Esc closes
    delete (window as never as { api?: unknown }).api
  })

  it('renders the mic-denied row over everything else', () => {
    seedTarget()
    useVoiceStore.setState({ micSilent: true, modelStatus: 'absent' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    expect(screen.getByTestId('voice-flyout-denied')).toBeTruthy()
    expect(screen.queryByTestId('voice-flyout-model')).toBeNull()
  })

  it('renders the model-missing row with the Download CTA', async () => {
    const list = vi
      .fn()
      .mockResolvedValue([
        { id: 'kroko-en', label: 'Kroko EN', totalBytes: 55e6, isDefault: true, status: 'absent' }
      ])
    ;(window as never as { api: unknown }).api = { voice: { models: { list } } }
    seedTarget()
    useVoiceStore.setState({ modelStatus: 'absent' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    expect(screen.getByTestId('voice-flyout-model')).toBeTruthy()
    expect(screen.getByText('Download')).toBeTruthy()
    await act(async () => {}) // models.list resolves → label + size render
    expect(screen.getByTestId('voice-flyout-model').textContent).toContain('Kroko EN · 55 MB')
    delete (window as never as { api?: unknown }).api
  })
})

describe('VoiceFlyout — engine error state (V5, SPEC §3)', () => {
  it('shows the error row in the header slot; the draft stays editable AND sendable', async () => {
    const entry = seedTarget()
    useVoiceStore.setState({ engineError: true, draft: 'preserved through the crash' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    expect(screen.getByTestId('voice-flyout-error')).toBeTruthy()
    expect(screen.queryByTestId('voice-flyout-target')).toBeNull() // row takes the header slot
    // Draft preserved and still sendable — Send needs the registry, not the engine.
    const ta = screen.getByTestId('voice-flyout-input') as HTMLTextAreaElement
    expect(ta.value).toBe('preserved through the crash')
    fireEvent.click(screen.getByTitle(/Paste \+ submit/))
    await act(async () => {})
    expect(entry.paste).toHaveBeenCalledWith('preserved through the crash')
  })

  it('Restart clears the error and starts a new session', () => {
    const start = vi
      .fn()
      .mockResolvedValue({ ok: true, micStatus: 'granted', modelStatus: 'ready' })
    ;(window as never as { api: unknown }).api = { voice: { start } }
    seedTarget()
    useVoiceStore.setState({ engineError: true, draft: 'kept' })
    render(<VoiceFlyout anchor={ANCHOR} />)
    fireEvent.click(screen.getByTestId('voice-flyout-restart'))
    expect(useVoiceStore.getState().engineError).toBe(false)
    expect(start).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().draft).toBe('kept')
    delete (window as never as { api?: unknown }).api
  })

  it('mic-denied still outranks the error row', () => {
    seedTarget()
    useVoiceStore.setState({ engineError: true, micSilent: true })
    render(<VoiceFlyout anchor={ANCHOR} />)
    expect(screen.getByTestId('voice-flyout-denied')).toBeTruthy()
    expect(screen.queryByTestId('voice-flyout-error')).toBeNull()
  })
})

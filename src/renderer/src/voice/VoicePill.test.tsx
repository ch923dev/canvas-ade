// @vitest-environment jsdom
/**
 * Voice V3 — pill drag threshold / viewport clamp / debounced persist + hotkey PTT
 * semantics (plan §V3 tests). voiceSession is mocked so a "toggle" is observable without
 * IPC; the config surface is a window.api stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { VoicePill, clampPillPos, defaultPillPos, PILL_W, DRAG_THRESHOLD } from './VoicePill'
import { useVoiceStore } from '../store/voiceStore'

vi.mock('./voiceSession', () => ({
  startVoice: vi.fn(),
  stopVoice: vi.fn(),
  toggleVoice: vi.fn()
}))
import { startVoice, stopVoice, toggleVoice } from './voiceSession'

const configGet = vi.fn()
const configSet = vi.fn().mockResolvedValue({ ok: true })

async function mountPill(pos = { x: 50, y: 50 }): Promise<HTMLElement> {
  configGet.mockResolvedValue({ showPill: true, pillPosition: pos })
  const { container } = render(<VoicePill />)
  await act(async () => {}) // config.get resolves → pill renders
  const pill = container.querySelector('.voice-pill') as HTMLElement
  expect(pill).toBeTruthy()
  return pill
}

beforeEach(() => {
  ;(window as never as { api: unknown }).api = {
    voice: { config: { get: configGet, set: configSet } }
  }
  useVoiceStore.setState({
    capturing: false,
    level: 0,
    micSilent: false,
    micStatus: 'unknown',
    flyoutOpen: false,
    draft: '',
    partial: ''
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  delete (window as never as { api?: unknown }).api
})

describe('clampPillPos / defaultPillPos (pure)', () => {
  it('clamps into the viewport with the margin', () => {
    expect(clampPillPos({ x: -100, y: -100 }, 1000, 800)).toEqual({ x: 8, y: 8 })
    const c = clampPillPos({ x: 5000, y: 5000 }, 1000, 800)
    expect(c.x).toBe(1000 - PILL_W - 8)
    expect(c.y).toBe(800 - 34 - 8)
  })
  it('default sits bottom-center', () => {
    const d = defaultPillPos(1000, 800)
    expect(d.x).toBe(Math.round((1000 - PILL_W) / 2))
    expect(d.y).toBe(800 - 34 - 24)
  })
})

describe('VoicePill — drag vs click', () => {
  it('a movement under the threshold is a click → toggles the mic', async () => {
    const pill = await mountPill()
    fireEvent.pointerDown(pill, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(pill, {
      pointerId: 1,
      clientX: 100 + DRAG_THRESHOLD - 2,
      clientY: 100
    })
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 100 + DRAG_THRESHOLD - 2, clientY: 100 })
    expect(toggleVoice).toHaveBeenCalledTimes(1)
  })

  it('a real drag moves the pill, never toggles, and persists debounced', async () => {
    vi.useFakeTimers()
    const pill = await mountPill({ x: 50, y: 50 })
    fireEvent.pointerDown(pill, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(pill, { pointerId: 1, clientX: 130, clientY: 120 })
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 130, clientY: 120 })
    expect(toggleVoice).not.toHaveBeenCalled()
    expect(pill.style.left).toBe('80px') // 50 + 30
    expect(pill.style.top).toBe('70px') // 50 + 20
    expect(configSet).not.toHaveBeenCalled() // debounced — not yet written
    act(() => void vi.advanceTimersByTime(500))
    expect(configSet).toHaveBeenCalledWith({ pillPosition: { x: 80, y: 70 } })
  })

  it('drag clamps to the viewport', async () => {
    const pill = await mountPill({ x: 50, y: 50 })
    fireEvent.pointerDown(pill, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(pill, { pointerId: 1, clientX: 9000, clientY: 9000 })
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 9000, clientY: 9000 })
    expect(pill.style.left).toBe(`${window.innerWidth - PILL_W - 8}px`)
    expect(pill.style.top).toBe(`${window.innerHeight - 34 - 8}px`)
  })

  it('restores a persisted position clamped to the current viewport', async () => {
    const pill = await mountPill({ x: 99999, y: 99999 }) // e.g. saved on a bigger display
    expect(pill.style.left).toBe(`${window.innerWidth - PILL_W - 8}px`)
  })
})

describe('VoicePill — hotkey (Ctrl+Shift+M): tap toggles, hold is push-to-talk', () => {
  it('quick press from idle starts and stays listening', async () => {
    vi.useFakeTimers()
    await mountPill()
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    expect(startVoice).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.keyUp(window, { code: 'KeyM', key: 'M' })
    expect(stopVoice).not.toHaveBeenCalled() // toggle ON completed
  })

  it('held press is push-to-talk — release stops', async () => {
    vi.useFakeTimers()
    await mountPill()
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    expect(startVoice).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(900))
    fireEvent.keyUp(window, { code: 'KeyM', key: 'M' })
    expect(stopVoice).toHaveBeenCalledTimes(1)
  })

  it('quick press while listening stops', async () => {
    vi.useFakeTimers()
    await mountPill()
    useVoiceStore.setState({ capturing: true })
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    expect(startVoice).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.keyUp(window, { code: 'KeyM', key: 'M' })
    expect(stopVoice).toHaveBeenCalledTimes(1)
  })

  it('auto-repeat while held does not restart the session', async () => {
    await mountPill()
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, {
      code: 'KeyM',
      key: 'M',
      ctrlKey: true,
      shiftKey: true,
      repeat: true
    })
    fireEvent.keyDown(window, {
      code: 'KeyM',
      key: 'M',
      ctrlKey: true,
      shiftKey: true,
      repeat: true
    })
    expect(startVoice).toHaveBeenCalledTimes(1)
  })

  it('ignores the chord without Shift', async () => {
    await mountPill()
    fireEvent.keyDown(window, { code: 'KeyM', key: 'm', ctrlKey: true })
    expect(startVoice).not.toHaveBeenCalled()
  })
})

describe('VoicePill — V4 config: custom hotkey + live push', () => {
  it('honors a configured accelerator instead of the default', async () => {
    configGet.mockResolvedValue({
      showPill: true,
      hotkey: 'Ctrl+Alt+V',
      pillPosition: { x: 50, y: 50 }
    })
    const { container } = render(<VoicePill />)
    await act(async () => {})
    expect(container.querySelector('.voice-pill')).toBeTruthy()
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    expect(startVoice).not.toHaveBeenCalled() // old default no longer bound
    fireEvent.keyDown(window, { code: 'KeyV', key: 'v', ctrlKey: true, altKey: true })
    expect(startVoice).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default chord when the configured hotkey is unparsable', async () => {
    configGet.mockResolvedValue({ showPill: true, hotkey: 'M', pillPosition: { x: 50, y: 50 } })
    render(<VoicePill />)
    await act(async () => {})
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    expect(startVoice).toHaveBeenCalledTimes(1)
  })

  it('applies a pushed config LIVE: showPill hides the pill, hotkey rebinds', async () => {
    let push: ((cfg: { showPill: boolean; hotkey?: string }) => void) | null = null
    const onChanged = vi.fn((cb: (cfg: { showPill: boolean; hotkey?: string }) => void) => {
      push = cb
      return () => {}
    })
    ;(window as never as { api: { voice: { config: unknown } } }).api = {
      voice: { config: { get: configGet, set: configSet, onChanged } }
    }
    const pill = await mountPill()
    expect(pill).toBeTruthy()
    act(() => push!({ showPill: false, hotkey: 'Ctrl+Alt+V' }))
    expect(document.querySelector('.voice-pill')).toBeNull() // hidden without a remount
    fireEvent.keyDown(window, { code: 'KeyV', key: 'v', ctrlKey: true, altKey: true })
    expect(startVoice).toHaveBeenCalledTimes(1) // hotkey still works while hidden, rebound
  })
})

describe('VoicePill — win-arm64 feature gate (V5)', () => {
  it('supported:false renders nothing and binds no hotkey', () => {
    ;(window as never as { api: unknown }).api = {
      voice: { supported: false, config: { get: configGet, set: configSet } }
    }
    const { container } = render(<VoicePill />)
    expect(container.querySelector('.voice-pill')).toBeNull()
    expect(configGet).not.toHaveBeenCalled() // fully dormant — no config restore either
    fireEvent.keyDown(window, { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })
    expect(startVoice).not.toHaveBeenCalled()
  })

  it('supported:true (or absent — older preload) keeps the pill live', async () => {
    ;(window as never as { api: unknown }).api = {
      voice: { supported: true, config: { get: configGet, set: configSet } }
    }
    const pill = await mountPill()
    expect(pill).toBeTruthy()
  })
})

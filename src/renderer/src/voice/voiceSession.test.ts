// @vitest-environment jsdom
/**
 * Voice — session controller (pill click / hotkey / flyout Esc funnel). The assertion added
 * for prompt-history: toggleVoice OPENS the flyout on activation so the panel (Recent history
 * + the listening composer) is visible immediately, without waiting for a first transcript.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toggleVoice } from './voiceSession'
import { useVoiceStore } from '../store/voiceStore'

const start = vi.fn().mockResolvedValue({ ok: true, micStatus: 'granted', modelStatus: 'ready' })
const stop = vi.fn().mockResolvedValue({ ok: true, frames: 0 })

beforeEach(() => {
  ;(window as never as { api: unknown }).api = { voice: { start, stop } }
  useVoiceStore.setState({ capturing: false, flyoutOpen: false })
})

afterEach(() => {
  vi.clearAllMocks()
  delete (window as never as { api?: unknown }).api
})

describe('toggleVoice', () => {
  it('idle → opens the flyout and starts a session (see history without dictating)', () => {
    toggleVoice()
    expect(useVoiceStore.getState().flyoutOpen).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  it('capturing → stops the session and never force-opens the flyout', () => {
    useVoiceStore.setState({ capturing: true, flyoutOpen: false })
    toggleVoice()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().flyoutOpen).toBe(false)
  })
})

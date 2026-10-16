// @vitest-environment jsdom
/**
 * Voice — session controller (pill click / hotkey / flyout Esc funnel). The assertion added
 * for prompt-history: toggleVoice OPENS the flyout on activation so the panel (Recent history
 * + the listening composer) is visible immediately, without waiting for a first transcript.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CONVERSE_LOCAL_MODEL_TOAST_ID, startVoice, toggleVoice } from './voiceSession'
import { useVoiceStore } from '../store/voiceStore'
import { useJarvisStore } from '../store/jarvisStore'
import { useToastStore } from '../store/toastStore'

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

// ── B0.1: startVoice is the single start choke point — it derives the converse flag MAIN uses to
// pin a conversation to local STT, and surfaces the "why do I need a local model" toast. ──

describe('startVoice (B0.1 converse routing)', () => {
  beforeEach(() => {
    useJarvisStore.setState({ converseMode: false })
    useToastStore.setState({ toasts: [] })
    useVoiceStore.setState({ sessionCloud: false, modelStatus: 'unknown' })
  })

  const converseToast = (): unknown =>
    useToastStore.getState().toasts.find((t) => t.id === CONVERSE_LOCAL_MODEL_TOAST_ID)

  it('a dictation start says converse:false and records the engine MAIN picked', async () => {
    start.mockResolvedValueOnce({
      ok: true,
      micStatus: 'granted',
      modelStatus: 'ready',
      cloud: true,
      converseLocal: false
    })
    await startVoice()
    expect(start).toHaveBeenCalledWith({ converse: false })
    expect(useVoiceStore.getState().sessionCloud).toBe(true)
  })

  it('a start while a conversation is armed is a converse start (every path, not just the arm)', async () => {
    useJarvisStore.setState({ converseMode: true })
    await startVoice()
    expect(start).toHaveBeenCalledWith({ converse: true })
    expect(useVoiceStore.getState().sessionCloud).toBe(false)
  })

  it('converse overrode cloud and the local model is missing → a visible toast + the flyout CTA', async () => {
    useJarvisStore.setState({ converseMode: true })
    start.mockResolvedValueOnce({
      ok: true,
      micStatus: 'granted',
      modelStatus: 'absent',
      cloud: false,
      converseLocal: true
    })
    await startVoice()
    expect(converseToast()).toMatchObject({ kind: 'error', action: { label: 'Voice settings' } })
    expect(useVoiceStore.getState().flyoutOpen).toBe(true) // the Download CTA row
  })

  it('a LOCAL-engine user with no model gets the flyout row alone (no new toast)', async () => {
    useJarvisStore.setState({ converseMode: true })
    start.mockResolvedValueOnce({
      ok: true,
      micStatus: 'granted',
      modelStatus: 'absent',
      cloud: false,
      converseLocal: false
    })
    await startVoice()
    expect(converseToast()).toBeUndefined()
    expect(useVoiceStore.getState().flyoutOpen).toBe(true)
  })

  it('converse overrode cloud but the local model is installed → it just works, no toast', async () => {
    useJarvisStore.setState({ converseMode: true })
    start.mockResolvedValueOnce({
      ok: true,
      micStatus: 'granted',
      modelStatus: 'ready',
      cloud: false,
      converseLocal: true
    })
    await startVoice()
    expect(converseToast()).toBeUndefined()
  })
})

// @vitest-environment jsdom
/**
 * Jarvis — the converse-mode controller's STRUCTURAL MIC-GATE under racing transitions
 * (review wave MIC-1/MIC-2): the arm chain is multi-await, and a close landing inside
 * any of those windows must leave NO consumer registered, NO capture starting, and the
 * composer un-suppressed. The disarm stop is unconditional — `capturing` only flips true
 * after the async arm chain, so gating the stop on it skipped the stop exactly when the
 * mic was still arming.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { closeJarvisPanel, setConverseMode } from './jarvisSession'
import { useJarvisStore } from '../store/jarvisStore'
import { useVoiceStore } from '../store/voiceStore'
import { consumeFinal } from '../voice/finalConsumer'

const CONFIG = {
  enabled: true,
  name: 'Jarvis',
  tonePreset: 'butler',
  customToneText: '',
  speakingRate: 1.05,
  verbosity: 'concise',
  announcePolicy: 'attention',
  model: 'claude-opus-4-8',
  historyMode: 'session'
}
const STATUS_OK = { hasKey: true, encryptionAvailable: true, mockEnabled: false, config: CONFIG }

const status = vi.fn()
const ttsStatus = vi.fn()
const startTurn = vi.fn()
const cancelTurn = vi.fn().mockResolvedValue({ ok: true })
const voiceStart = vi
  .fn()
  .mockResolvedValue({ ok: true, micStatus: 'granted', modelStatus: 'ready' })
const voiceStop = vi.fn().mockResolvedValue({ ok: true, frames: 0 })

beforeEach(() => {
  status.mockResolvedValue(STATUS_OK)
  ttsStatus.mockResolvedValue({ modelId: 'kokoro-en-v0_19', modelStatus: 'ready', active: false })
  ;(window as never as { api: unknown }).api = {
    jarvis: { status, startTurn, cancelTurn },
    voice: { start: voiceStart, stop: voiceStop, tts: { status: ttsStatus } }
  }
  useJarvisStore.setState({ panelOpen: true, converseMode: false, lastError: null })
  useVoiceStore.setState({ capturing: false, composerSuppressed: false })
})

afterEach(async () => {
  await setConverseMode(false) // reset module state (consumer/generation) between tests
  vi.clearAllMocks()
  delete (window as never as { api?: unknown }).api
})

describe('setConverseMode arm/close races (MIC-1)', () => {
  it('a close landing during the status await leaves no consumer, no capture, no suppression', async () => {
    let resolveStatus: (v: typeof STATUS_OK) => void = () => {}
    status.mockReturnValueOnce(new Promise((r) => (resolveStatus = r)))
    const arm = setConverseMode(true)
    closeJarvisPanel() // double-tap hotkey / Esc while the arm is still in flight
    resolveStatus(STATUS_OK)
    await arm
    expect(useJarvisStore.getState().converseMode).toBe(false)
    expect(useJarvisStore.getState().panelOpen).toBe(false)
    expect(useVoiceStore.getState().composerSuppressed).toBe(false)
    expect(voiceStart).not.toHaveBeenCalled() // the mic never armed behind the closed panel
    expect(consumeFinal('route me to the brain')).toBe(false) // no consumer registered
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('a close landing during the TTS probe await is just as dead', async () => {
    let resolveTts: (v: unknown) => void = () => {}
    ttsStatus.mockReturnValueOnce(new Promise((r) => (resolveTts = r)))
    const arm = setConverseMode(true)
    await vi.waitFor(() => expect(ttsStatus).toHaveBeenCalled()) // arm parked on the TTS probe
    closeJarvisPanel()
    resolveTts({ modelId: 'x', modelStatus: 'ready', active: false })
    await arm
    expect(useJarvisStore.getState().converseMode).toBe(false)
    expect(voiceStart).not.toHaveBeenCalled()
    expect(consumeFinal('anything')).toBe(false)
  })

  it('a rapid re-arm supersedes the first arm (single consumer, converse ends up on)', async () => {
    let resolveFirst: (v: typeof STATUS_OK) => void = () => {}
    status.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
    const arm1 = setConverseMode(true)
    const arm2 = setConverseMode(true) // second gesture while the first is in flight
    resolveFirst(STATUS_OK)
    await Promise.all([arm1, arm2])
    expect(useJarvisStore.getState().converseMode).toBe(true)
    expect(voiceStart).toHaveBeenCalledTimes(1) // only the surviving arm started capture
  })

  it('a stale arm resolving after a superseding LIVE arm does not stop the successor mic (#349 review)', async () => {
    // Arm A blocks inside its voice:start round-trip…
    let resolveStartA: (v: unknown) => void = () => {}
    voiceStart.mockReturnValueOnce(new Promise((r) => (resolveStartA = r)))
    const armA = setConverseMode(true)
    await vi.waitFor(() => expect(voiceStart).toHaveBeenCalledTimes(1))
    // …a close disarms it (staleness by disarm), then a reopen arms B to completion —
    // B now owns the live, legitimate session.
    closeJarvisPanel()
    useJarvisStore.getState().setPanelOpen(true)
    await setConverseMode(true)
    expect(useJarvisStore.getState().converseMode).toBe(true)
    const stopsAfterB = voiceStop.mock.calls.length
    // A's start finally settles: staleness == superseded, NOT disarmed. The re-stop
    // must not fire — voice:session:stop is a global stop and would kill B's mic
    // while the panel still shows converse armed.
    resolveStartA({ ok: true, micStatus: 'granted', modelStatus: 'ready' })
    await armA
    expect(voiceStop.mock.calls.length).toBe(stopsAfterB)
    expect(useJarvisStore.getState().converseMode).toBe(true)
  })
})

describe('disarm stops the mic unconditionally (MIC-2)', () => {
  it('stops voice even when `capturing` has not flipped true yet', async () => {
    await setConverseMode(true) // full arm: converse on, capture starting (still false)
    expect(useJarvisStore.getState().converseMode).toBe(true)
    expect(useVoiceStore.getState().capturing).toBe(false) // the pre-fix skip window
    await setConverseMode(false)
    expect(voiceStop).toHaveBeenCalled() // pre-fix: skipped, port arrived, hot mic
    expect(useJarvisStore.getState().converseMode).toBe(false)
  })

  it('re-stops after a voice:start round-trip that raced the disarm', async () => {
    let resolveStart: (v: unknown) => void = () => {}
    voiceStart.mockReturnValueOnce(new Promise((r) => (resolveStart = r)))
    const arm = setConverseMode(true)
    await vi.waitFor(() => expect(voiceStart).toHaveBeenCalled())
    closeJarvisPanel() // stop #1 may reach MAIN before the start settles
    const stopsAtClose = voiceStop.mock.calls.length
    resolveStart({ ok: true, micStatus: 'granted', modelStatus: 'ready' })
    await arm
    expect(voiceStop.mock.calls.length).toBeGreaterThan(stopsAtClose) // stop #2 after start settled
  })
})

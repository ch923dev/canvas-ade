/**
 * Jarvis J2 — ephemeral TTS playback state (the voiceStore discipline: session-state
 * ONLY, never serialized, never routed into boardSchema or a board patch key). The
 * playback pipeline (`useTtsPlayback`) writes it; barge-in, the mic half-duplex gate and
 * the Settings preview button read it.
 */
import { create } from 'zustand'

/** Echo-filter reference window: the texts recently sent to the synthesizer. STT partials
 *  matching one of these while audio plays are self-capture, not the user interrupting. */
export const RECENT_SPOKEN_CAP = 4

interface TtsState {
  /** A TTS session is open with MAIN (port brokered). Flips false on an engine event —
   *  the next speak lazily re-opens it. */
  sessionLive: boolean
  /** Audio is scheduled/audible right now (drives barge-in arming + the mic gate). */
  speaking: boolean
  /** Barge-in mode mirror of voiceConfig.ttsDuplex (D6) — hydrated at mount, re-synced
   *  on voice:config:changed. */
  duplex: 'full' | 'half'
  /** Last TTS failure surfaced to the UI ('model-absent' | an engine reason); cleared on
   *  the next successful start. */
  lastError: string | null
  /** Newest-first texts handed to speak(), capped — the echo-filter reference. */
  recentSpokenTexts: string[]
  sessionStarted: () => void
  sessionLost: (reason: string) => void
  setSpeaking: (on: boolean) => void
  setDuplex: (mode: 'full' | 'half') => void
  setError: (err: string | null) => void
  spokeText: (text: string) => void
}

export const useTtsStore = create<TtsState>((set) => ({
  sessionLive: false,
  speaking: false,
  duplex: 'full',
  lastError: null,
  recentSpokenTexts: [],
  sessionStarted: () => set({ sessionLive: true, lastError: null }),
  sessionLost: (reason) => set({ sessionLive: false, speaking: false, lastError: reason }),
  setSpeaking: (on) => set((s) => (s.speaking === on ? s : { speaking: on })),
  setDuplex: (duplex) => set((s) => (s.duplex === duplex ? s : { duplex })),
  setError: (lastError) => set({ lastError }),
  spokeText: (text) =>
    set((s) => ({ recentSpokenTexts: [text, ...s.recentSpokenTexts].slice(0, RECENT_SPOKEN_CAP) }))
}))

/** Half-duplex mic gate (D6 fallback): while TTS speaks in 'half' mode, capture frames
 *  are NOT forwarded to the STT host (no echo transcription); the level meter and the
 *  RMS barge-in gate keep running renderer-side. Read per frame by useVoiceCapture. */
export function suppressMicForward(): boolean {
  const s = useTtsStore.getState()
  return s.duplex === 'half' && s.speaking
}

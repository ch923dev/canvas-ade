/**
 * Jarvis J2 — the one TTS controller (Settings preview today; the J3 brain's sentence
 * chunker funnels here next). Mirrors voiceSession.ts: thin async verbs over the preload
 * control plane, session opened lazily on the first speak, all playback state in
 * ttsStore. cancelSpeech() is the barge-in verb: local duck-and-flush FIRST (≤100 ms,
 * never waits on IPC), then the host-side cancel.
 */
import { getTtsPlayer } from './ttsPlayback'
import { useTtsStore } from '../store/ttsStore'

/**
 * Speak `text` through the configured TTS model, opening the session if needed.
 * Resolves true when the utterance was accepted (chunks will stream to the player).
 */
export async function speakText(text: string): Promise<boolean> {
  const api = window.api?.voice?.tts
  if (!api) return false // non-electron test runtimes (App.tsx discipline)
  const store = useTtsStore.getState()
  if (!store.sessionLive) {
    try {
      const r = await api.start()
      if (!r.ok) {
        store.setError(r.modelStatus === 'absent' ? 'model-absent' : 'start-failed')
        return false
      }
    } catch {
      return false // MAIN gone (shutdown)
    }
    // The port arrives async via __voiceTtsPort (chunks queue in it until adopted);
    // the session itself is live the moment start() resolves ok.
    useTtsStore.getState().sessionStarted()
  }
  try {
    const r = await api.speak(text)
    if (!r.ok) {
      useTtsStore.getState().setError(r.error ?? 'speak failed')
      return false
    }
    useTtsStore.getState().spokeText(text)
    return true
  } catch {
    return false
  }
}

/** Barge-in / user stop: duck + flush locally (immediate), then cancel host synthesis. */
export async function cancelSpeech(): Promise<void> {
  getTtsPlayer()?.duckAndFlush()
  try {
    await window.api?.voice?.tts?.cancel()
  } catch {
    /* MAIN gone — local flush already silenced playback */
  }
}

/**
 * Jarvis J2 — the one TTS controller (Settings preview today; the J3 brain's sentence
 * chunker funnels here next). Mirrors voiceSession.ts: thin async verbs over the preload
 * control plane, session opened lazily on the first speak, all playback state in
 * ttsStore. cancelSpeech() is the barge-in verb: local duck-and-flush FIRST (≤100 ms,
 * never waits on IPC), then the host-side cancel.
 */
import { getTtsPlayer } from './ttsPlayback'
import { useTtsStore } from '../store/ttsStore'

// ── J3: the barge-in listener registry. useTtsPlayback's interrupt trigger calls
// notifyBargeIn() so the Jarvis controller can cancel the in-flight LLM stream in the
// same beat as the audio flush (KICKOFF-J3 §1.2 — no such hook existed before J3).
const bargeInListeners = new Set<() => void>()

/** Subscribe to barge-in (user talked over playback). Returns an unsubscribe fn. */
export function onBargeIn(cb: () => void): () => void {
  bargeInListeners.add(cb)
  return () => bargeInListeners.delete(cb)
}

/** Fire the barge-in listeners (useTtsPlayback's trigger; a listener throw never breaks the flush). */
export function notifyBargeIn(): void {
  for (const cb of bargeInListeners) {
    try {
      cb()
    } catch {
      /* listener bug must not block the interrupt */
    }
  }
}

/**
 * Speak `text` through the configured TTS model, opening the session if needed.
 * Resolves true when the utterance was accepted (chunks will stream to the player).
 * `opts` (J3): per-utterance speaker id + rate — the persona voice settings.
 */
export async function speakText(
  text: string,
  opts?: { sid?: number; speed?: number }
): Promise<boolean> {
  const api = window.api?.voice?.tts
  if (!api) return false // non-electron test runtimes (App.tsx discipline)
  const store = useTtsStore.getState()
  // Re-open on EITHER signal: the store flag can outlive the player's port (the player
  // is rebuilt whenever the owning effect re-runs — dev HMR, React remount — and the
  // rebuilt one is portless while MAIN keeps streaming into the orphan). voice:tts:start
  // is re-broker-idempotent end to end (host closes the old port and adopts the new),
  // so over-calling it is safe; trusting a stale sessionLive is not.
  if (!store.sessionLive || !getTtsPlayer()?.attached()) {
    try {
      const r = await api.start()
      if (!r.ok) {
        store.setError(r.modelStatus === 'absent' ? 'model-absent' : 'start-failed')
        return false
      }
    } catch (err) {
      console.error('[tts] start threw', err)
      return false // MAIN gone (shutdown)
    }
    // The port arrives async via __voiceTtsPort (chunks queue in it until adopted);
    // the session itself is live the moment start() resolves ok.
    useTtsStore.getState().sessionStarted()
  }
  try {
    const r = await api.speak(text, opts)
    if (!r.ok) {
      useTtsStore.getState().setError(r.error ?? 'speak failed')
      return false
    }
    useTtsStore.getState().spokeText(text)
    return true
  } catch (err) {
    console.error('[tts] speak threw', err)
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

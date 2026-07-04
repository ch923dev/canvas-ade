/**
 * Voice V3 — the one session controller (pill click, hotkey, flyout Esc all funnel here).
 * start() resolves with the OS mic grant + default-model install state; the MessagePort it
 * makes MAIN broker is the actual start signal (useVoiceCapture arms on its arrival), so
 * `capturing` flips true asynchronously via `captureStarted`. stop() round-trips MAIN —
 * the engine host posts {t:'stop'} back over the port and the capture disposes (mic
 * released, tail folded into the draft) BEFORE the invoke resolves (the eos drain), so
 * `await stopVoice()` is a safe fence for "the transcript is settled now".
 */
import { useVoiceStore } from '../store/voiceStore'

export async function startVoice(): Promise<void> {
  const api = window.api?.voice
  if (!api) return // non-electron test runtimes (App.tsx discipline)
  try {
    const res = await api.start()
    const s = useVoiceStore.getState()
    s.sessionInfo(res.micStatus, res.modelStatus)
    // Attention states surface immediately: model-missing (capture still runs — the host
    // counts frames without a recognizer, so the Download CTA shows while the mic is hot)
    // and a hard OS denial. The silent-zeros watchdog covers the no-error denial case.
    if (res.modelStatus === 'absent' || res.micStatus === 'denied') s.setFlyoutOpen(true)
  } catch {
    /* MAIN gone (shutdown) — nothing to surface */
  }
}

export async function stopVoice(): Promise<void> {
  try {
    await window.api?.voice?.stop()
  } catch {
    /* MAIN gone — the capture's port close path already released the mic */
  }
}

/** Quick-press semantics (pill click / hotkey tap): flip the mic. */
export function toggleVoice(): void {
  if (useVoiceStore.getState().capturing) void stopVoice()
  else void startVoice()
}

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
import { useJarvisStore } from '../store/jarvisStore'
import { useToastStore } from '../store/toastStore'

/** Keyed so a repeat (re-arm, Restart, the model-download cycle) replaces the toast in place. */
export const CONVERSE_LOCAL_MODEL_TOAST_ID = 'voice-converse-local-model'

export async function startVoice(): Promise<void> {
  const api = window.api?.voice
  if (!api) return // non-electron test runtimes (App.tsx discipline)
  // B0.1: a start while a Jarvis conversation is armed IS a converse session — MAIN pins it to
  // local STT (cloud is batch-on-release: one final when the session ends = zero turns). Derived
  // HERE, the single start choke point (the converse arm, a pill/hotkey re-start mid-conversation,
  // the flyout's Restart and model-download cycle all funnel through), so no path can forget it.
  const converse = useJarvisStore.getState().converseMode
  try {
    const res = await api.start({ converse })
    const s = useVoiceStore.getState()
    s.sessionInfo(res.micStatus, res.modelStatus, res.cloud === true)
    // Attention states surface immediately: model-missing (capture still runs — the host
    // counts frames without a recognizer, so the Download CTA shows while the mic is hot)
    // and a hard OS denial. The silent-zeros watchdog covers the no-error denial case.
    if (res.modelStatus === 'absent' || res.micStatus === 'denied') s.setFlyoutOpen(true)
    // Fail VISIBLY when the conversation overrode a CLOUD selection and the on-device model it now
    // needs isn't installed: the flyout's model-missing row (above) carries the Download CTA, this
    // says WHY a cloud user is being asked for a local model. A local-engine user gets the row alone
    // (unchanged) — for them the missing model is the whole story.
    if (res.converseLocal && res.modelStatus === 'absent') {
      useToastStore.getState().showToast({
        id: CONVERSE_LOCAL_MODEL_TOAST_ID,
        kind: 'error',
        message:
          'Jarvis conversations use on-device speech recognition (cloud transcription only ' +
          'returns text when you stop). Download the speech model to talk to Jarvis.',
        action: {
          label: 'Voice settings',
          run: () =>
            window.dispatchEvent(
              new CustomEvent('expanse:open-settings', { detail: { section: 'voice' } })
            )
        }
      })
    }
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
  const s = useVoiceStore.getState()
  if (s.capturing) {
    void stopVoice()
  } else {
    // Open the flyout on activation so the panel (listening composer + Recent history) is
    // visible immediately — you get instant feedback the mic armed, and can review/reuse a
    // past prompt without waiting for a first transcript to arrive.
    s.setFlyoutOpen(true)
    void startVoice()
  }
}

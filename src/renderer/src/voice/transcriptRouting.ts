/**
 * Voice — where a recognized segment goes (the dictation draft vs the Jarvis converse consumer).
 * Split out of useVoiceCapture so the routing rules unit-test without the capture graph (that
 * module pulls the `?worker&url` worklet chunk + Web Audio).
 *
 * The rules (B0, the converse/cloud hotfix):
 *  - A LOCAL streaming final (over the session port) is offered to the armed converse consumer
 *    first; an unconsumed one folds into the draft (J3 seam, unchanged).
 *  - A CLOUD batch final (out-of-band on voice:transcript) is DICTATION by construction — MAIN
 *    never runs a converse session on cloud (voiceIpc pins converse to local STT) — so it goes
 *    straight to the draft, never the consumer. That matters when a conversation arms while a
 *    cloud dictation is still transcribing, or replaces a live cloud session: the user dictated
 *    that text, it must not be shipped to the brain as a Jarvis utterance.
 *  - The provisional TAIL a stop solidifies (SPEC §3 `finalizing`) is routed like any other local
 *    final. Before B0 it was folded into the draft unconditionally, so every converse teardown /
 *    stop mid-utterance leaked the Jarvis speech into the hidden dictation composer.
 */
import { useVoiceStore } from '../store/voiceStore'
import { consumeFinal } from './finalConsumer'

/** Route a LOCAL final: the armed converse consumer takes it, else it folds into the draft. */
export function applyFinal(text: string): void {
  if (!consumeFinal(text)) useVoiceStore.getState().finalReceived(text)
  else useVoiceStore.getState().partialReceived('')
}

/** Route a CLOUD batch final: always the dictation draft (see the module note). */
export function applyCloudFinal(text: string): void {
  useVoiceStore.getState().finalReceived(text)
}

/**
 * The capture stopped: solidify the provisional tail. The local engine never emits a final for a
 * stream it no longer receives, so the tail IS the utterance's last words — offer it to the converse
 * consumer like a final (during a converse teardown that is the drain, which swallows it); only an
 * unconsumed tail folds into the draft, exactly as before.
 */
export function solidifyTail(): void {
  const s = useVoiceStore.getState()
  if (s.partial.trim() && consumeFinal(s.partial)) s.partialReceived('')
  useVoiceStore.getState().captureStopped()
}

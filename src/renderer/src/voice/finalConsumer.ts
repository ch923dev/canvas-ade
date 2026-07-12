/**
 * Jarvis J3 — the pluggable final-transcript consumer (KICKOFF-J3 §1.2, the
 * terminalInputRegistry pattern). Dictation's default route folds finals into the flyout
 * draft; converse mode registers a consumer here and the capture pipeline offers every
 * final to it FIRST. Returning true swallows the final (the draft/flyout never see it).
 * A tiny module of its own so useVoiceCapture (voice) and jarvisSession (jarvis) share
 * it without an import cycle.
 */

export type FinalConsumer = (text: string) => boolean

let consumer: FinalConsumer | null = null

/** Register the converse-mode consumer; returns an unregister fn. Last writer wins
 *  (there is exactly one Jarvis controller; a second register replaces a stale one). */
export function setFinalConsumer(cb: FinalConsumer): () => void {
  consumer = cb
  return () => {
    if (consumer === cb) consumer = null
  }
}

/** Offer a final to the registered consumer. True = consumed (skip the dictation route). */
export function consumeFinal(text: string): boolean {
  if (!consumer) return false
  try {
    return consumer(text)
  } catch {
    return false // a consumer bug must never eat dictation
  }
}

/**
 * Jarvis listen-hold — the converse-mode utterance aggregator (fixes "Jarvis cuts me off
 * mid-sentence"). The STT engine endpoints on ~0.8–1 s pauses (dictation-tuned, where an
 * over-eager final is harmless — voiceEngineHost.ts), but converse used to ship EVERY
 * final to the brain immediately, so a thinking pause split one prompt into competing
 * turns (each superseding the last). This module buffers finals instead:
 *
 *   - every final APPENDS to a pending utterance (joinFinal — the dictation joiner);
 *   - 'auto' mode arms a hold timer per final; a live partial (speech resumed) cancels
 *     it, the NEXT final re-arms it — the buffer only sends after `holdMs` of true
 *     post-speech silence;
 *   - 'manual' mode never arms a timer — the user says a send word ("send it") or
 *     presses Send in the panel (both land on flush()).
 *
 * Pure over injected timers (setTimeout default) so it unit-tests with fake timers; the
 * pending text is ephemeral session state only (never serialized — the voiceStore SPEC §2
 * discipline).
 */
import { joinFinal } from '../store/voiceStore'

/** Renderer mirror of MAIN's JarvisListenMode (duplicated across the bundle boundary —
 *  the JarvisConfigView discipline). */
export type JarvisListenMode = 'auto' | 'manual'

/**
 * Spoken send triggers — exact-match ONLY after trimming punctuation (the
 * matchConfirmSpeech discipline): "send it to the planning board" must stay content, not
 * a trigger. Works in BOTH modes ('auto' skips the remaining hold; 'manual' is the send).
 */
export function matchSendSpeech(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[.,!?…]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [
    'send',
    'send it',
    'send that',
    'send now',
    'go ahead',
    "that's it",
    'that is it'
  ].includes(t)
}

export interface UtteranceHold {
  /** Append one final to the pending utterance; 'auto' (re)arms the hold timer. */
  pushFinal(text: string, mode: JarvisListenMode, holdMs: number): void
  /** Speech state changed: a non-empty partial means the user resumed talking — cancel
   *  the armed hold so the buffer keeps growing (the next final re-arms it). */
  touchPartial(speaking: boolean): void
  /** Send the pending utterance NOW (send word / panel button). No-op when empty. */
  flush(): void
  /** Discard the pending utterance (disarm / panel close). */
  clear(): void
  pending(): string
}

export function createUtteranceHold(opts: {
  onSend: (text: string) => void
  /** Pending-text mirror for the panel's composing row (called on every change). */
  onChange?: (pending: string) => void
}): UtteranceHold {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const setPending = (text: string): void => {
    if (pending === text) return
    pending = text
    opts.onChange?.(pending)
  }
  const send = (): void => {
    cancelTimer()
    const text = pending
    setPending('')
    if (text) opts.onSend(text)
  }

  return {
    pushFinal(text, mode, holdMs) {
      setPending(joinFinal(pending, text))
      cancelTimer()
      if (mode === 'auto' && pending) timer = setTimeout(send, holdMs)
    },
    touchPartial(speaking) {
      // Only CANCEL on resumed speech — never re-arm here: the tail partial empties when
      // its final lands, and that final's own pushFinal owns the re-arm.
      if (speaking) cancelTimer()
    },
    flush: send,
    clear() {
      cancelTimer()
      setPending('')
    },
    pending: () => pending
  }
}

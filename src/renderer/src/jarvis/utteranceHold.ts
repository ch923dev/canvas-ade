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
  /** Append one final to the pending utterance; 'auto' (re)arms the hold timer. While
   *  paused (edit session live) the final DEFERS to a side buffer instead — a controlled
   *  textarea must never change under the user's caret — and folds in on resume/flush. */
  pushFinal(text: string, mode: JarvisListenMode, holdMs: number): void
  /** The listen config changed LIVE (Settings flip): 'manual' must cancel an armed
   *  countdown (nothing auto-sends after the flip); 'auto' arms over an already-pending
   *  buffer so it doesn't sit forever waiting for a next final. */
  modeChanged(mode: JarvisListenMode, holdMs: number): void
  /** Speech state changed: a non-empty partial means the user resumed talking — cancel
   *  the armed hold so the buffer keeps growing (the next final re-arms it). */
  touchPartial(speaking: boolean): void
  /** The user is EDITING the buffer (composing textarea focus): cancel any armed hold
   *  and block auto re-arm — a mid-edit final must never ship a half-edited prompt. */
  pause(): void
  /** Editing ended (blur): unblock, and in 'auto' mode re-arm over the current buffer. */
  resume(mode: JarvisListenMode, holdMs: number): void
  /** Replace the pending text with the user's edit (never arms a timer — edits are not
   *  speech; pair with pause()/resume() around the edit session). */
  setText(text: string): void
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
  /** Finals spoken DURING an edit session park here (the textarea is a controlled input
   *  bound to `pending` — mutating it mid-edit yanks the caret); folded in on resume/flush. */
  let deferred = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Edit session live — the auto hold must not arm under the user's caret. */
  let paused = false
  /** Last listen config seen — modeChanged() no-ops on unrelated jarvis:config pushes
   *  (persona rename, speaking-rate slider…) so they never disturb an armed countdown. */
  let lastMode: JarvisListenMode | null = null
  let lastHoldMs = 0

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
    // A send ends any edit session (the textarea unmounts with the emptied buffer, so no
    // blur/resume may ever come) — unstick `paused` here or later finals would defer
    // into an invisible buffer forever.
    paused = false
    const text = joinFinal(pending, deferred)
    deferred = ''
    setPending('')
    if (text) opts.onSend(text)
  }
  const arm = (mode: JarvisListenMode, holdMs: number): void => {
    lastMode = mode
    lastHoldMs = holdMs
    if (!paused && mode === 'auto' && pending) timer = setTimeout(send, holdMs)
  }

  return {
    pushFinal(text, mode, holdMs) {
      if (paused) {
        deferred = joinFinal(deferred, text)
        return
      }
      setPending(joinFinal(pending, text))
      cancelTimer()
      arm(mode, holdMs)
    },
    touchPartial(speaking) {
      // Only CANCEL on resumed speech — never re-arm here: the tail partial empties when
      // its final lands, and that final's own pushFinal owns the re-arm.
      if (speaking) cancelTimer()
    },
    modeChanged(mode, holdMs) {
      // Every jarvis:config:changed push lands here (the session can't tell which field
      // moved) — an UNRELATED change (persona rename, speaking-rate slider mid-drag)
      // must not cancel/reset an armed countdown. Only a real listen-config change acts.
      if (mode === lastMode && holdMs === lastHoldMs) return
      cancelTimer()
      arm(mode, holdMs)
    },
    pause() {
      paused = true
      cancelTimer()
    },
    resume(mode, holdMs) {
      paused = false
      if (deferred) {
        setPending(joinFinal(pending, deferred))
        deferred = ''
      }
      cancelTimer()
      arm(mode, holdMs)
    },
    setText(text) {
      setPending(text)
      cancelTimer()
    },
    flush: send,
    clear() {
      cancelTimer()
      paused = false
      deferred = ''
      setPending('')
    },
    pending: () => pending
  }
}

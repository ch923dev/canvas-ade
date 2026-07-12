/**
 * Voice V1/V3 — ephemeral dictation session state (SPEC §2: zero board-schema impact).
 * Session-state ONLY, mirroring `terminalRuntimeStore`'s role: NOTHING here is ever
 * serialized, routed into `boardSchema`, or added to `PATCHABLE_KEYS`. The capture
 * pipeline (`useVoiceCapture`) writes it; the V3 pill/flyout reads it.
 *
 * V3 adds the transcript composer state: `draft` (finalized + user-edited text — the
 * textarea value), `partial` (the provisional dimmed-italic tail; replaced wholesale on
 * every `{t:'partial'}`, folded into `draft` on `{t:'final'}` so already-solid text never
 * reflows), the flyout open flag, and the start()-reported mic/model statuses that drive
 * the `mic-denied` / `model-missing` attention rows.
 */
import { create } from 'zustand'

/** RMS floor under which a frame counts as silence (drives the ~15 s auto-STOP). */
export const SILENCE_RMS = 0.015

/** Append a final segment to the draft with a single joining space (never reflows draft).
 *  Incoming segments are edge-trimmed — sherpa partials/finals can carry a leading space
 *  (seen live with Kroko), which would double up against the joiner. Finals only fire at
 *  utterance endpoints, never mid-word, so trimming cannot merge words. */
export function joinFinal(draft: string, text: string): string {
  const seg = text.trim()
  if (!seg) return draft
  if (!draft) return seg
  return /\s$/.test(draft) ? draft + seg : draft + ' ' + seg
}

/** Renderer-side cap on the prompt-history ring, mirroring MAX_PROMPT_HISTORY in
 *  main/voiceConfig.ts (the renderer can't import from MAIN). Slicing here keeps the
 *  config.set payload bounded; MAIN's repair enforces the same cap authoritatively. */
export const PROMPT_HISTORY_CAP = 200

/** Prepend a just-sent prompt to the history ring: trim, drop empties, skip a consecutive
 *  duplicate (re-sending the same prompt back-to-back never stacks), cap to `cap`. Pure — it
 *  is the reducer for BOTH the optimistic store update and the config.set payload, so the two
 *  can never diverge. Returns the SAME reference when nothing changes (cheap no-op guard). */
export function pushHistory(list: string[], text: string, cap = PROMPT_HISTORY_CAP): string[] {
  const t = text.trim()
  if (!t) return list
  if (list[0] === t) return list
  return [t, ...list].slice(0, cap)
}

interface VoiceState {
  /** True while the mic capture pipeline is live (worklet wired, frames flowing). */
  capturing: boolean
  /** Normalized 0..1 RMS of the last emitted frame (drives the pill level bars). */
  level: number
  /** Silent-zeros watchdog verdict — a live all-zeros stream means the OS denied the
   *  mic without an error (electron#42714); surfaced as `mic-denied` in the flyout. */
  micSilent: boolean
  /** Frames forwarded to MAIN this session (e2e/devtools observability; reset on start). */
  framesSent: number
  /** The terminal board dictation targets (V3 flyout header); unused in V1. */
  activeBoardId: string | null
  /** Finalized + user-edited transcript (the editable textarea value). Survives selection
   *  change, board delete, Esc-close and mic stop — cleared only by Send/Insert/setDraft(''). */
  draft: string
  /** Provisional recognition tail (dimmed italic); replaced on each partial, emptied on final. */
  partial: string
  /** Flyout visibility — opened on the first partial/final or an attention state; an
   *  explicit close keeps the draft. */
  flyoutOpen: boolean
  /** J3 converse mode: suppress the dictation composer's auto-open (partials/finals belong
   *  to the Jarvis turn, not the flyout draft). The flyout still opens for attention states. */
  composerSuppressed: boolean
  /** OS mic grant reported by the last voice.start() ('granted'|'denied'|…|'unknown'). */
  micStatus: string
  /** Default model install state from the last voice.start() ('unknown' before any start). */
  modelStatus: 'ready' | 'absent' | 'unknown'
  /** V5 SPEC §3 `error` state: the engine crashed past its restart budget. The draft is
   *  untouched — the flyout shows the error row with Restart until a new start clears it. */
  engineError: boolean
  /** Epoch ms of the last frame whose RMS beat SILENCE_RMS (silence auto-stop input). */
  lastVoiceAt: number
  /** Epoch ms the live capture session armed (the ~2 min hard-cap input). */
  captureStartedAt: number
  captureStarted: () => void
  captureStopped: () => void
  /** One frame left for MAIN: update the level + count it. */
  frameSent: (rms: number) => void
  setMicSilent: (silent: boolean) => void
  setActiveBoard: (id: string | null) => void
  /** start() resolved — record the session's mic/model statuses (attention rows). */
  sessionInfo: (micStatus: string, modelStatus: 'ready' | 'absent') => void
  /** `{t:'partial'}` from the engine host: replace the tail; open the flyout on first text. */
  partialReceived: (text: string) => void
  /** `{t:'final'}`: fold the segment into the draft (tail-only replacement, no reflow). */
  finalReceived: (text: string) => void
  /** User edit — the textarea is the source of truth for the solid text. */
  setDraft: (text: string) => void
  /** Send/Insert consumed the transcript — drop draft AND tail in one update. */
  clearTranscript: () => void
  setFlyoutOpen: (open: boolean) => void
  setComposerSuppressed: (on: boolean) => void
  /** Download CTA completion flips 'absent' → 'ready' without another start(). */
  setModelStatus: (s: 'ready' | 'absent' | 'unknown') => void
  setEngineError: (on: boolean) => void
  /** Sent-prompt history mirror (newest first) — hydrated from voiceConfig at pill mount and
   *  re-synced on voice:config:changed. Render cache only; the source of truth is the durable
   *  userData/voice-config.json ring (never a project file, never session-serialized). */
  recent: string[]
  setRecent: (list: string[]) => void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  capturing: false,
  level: 0,
  micSilent: false,
  framesSent: 0,
  activeBoardId: null,
  draft: '',
  partial: '',
  flyoutOpen: false,
  composerSuppressed: false,
  micStatus: 'unknown',
  modelStatus: 'unknown',
  engineError: false,
  lastVoiceAt: 0,
  captureStartedAt: 0,
  captureStarted: () =>
    set({
      capturing: true,
      level: 0,
      micSilent: false,
      framesSent: 0,
      engineError: false, // a fresh session (incl. Restart) leaves the error state
      captureStartedAt: Date.now(),
      // A fresh session starts its silence clock NOW — else a stale lastVoiceAt from a
      // previous session would auto-stop this one immediately.
      lastVoiceAt: Date.now()
    }),
  // framesSent survives the stop so a probe can read the session total afterwards; the
  // draft/partial survive too (reviewing state — mic off, flyout stays for edit). A tail
  // still provisional when the mic stops solidifies: fold it into the draft (SPEC §3
  // `finalizing` — the engine won't emit a final for a stream it no longer receives).
  captureStopped: () =>
    set((s) => ({
      capturing: false,
      level: 0,
      micSilent: false,
      draft: joinFinal(s.draft, s.partial),
      partial: ''
    })),
  frameSent: (rms) =>
    set((s) => ({
      level: rms,
      framesSent: s.framesSent + 1,
      ...(rms > SILENCE_RMS ? { lastVoiceAt: Date.now() } : null)
    })),
  setMicSilent: (silent) => set((s) => (s.micSilent === silent ? s : { micSilent: silent })),
  setActiveBoard: (id) => set((s) => (s.activeBoardId === id ? s : { activeBoardId: id })),
  sessionInfo: (micStatus, modelStatus) => set({ micStatus, modelStatus }),
  partialReceived: (text) =>
    set((s) => ({
      partial: text,
      flyoutOpen: s.flyoutOpen || (text.length > 0 && !s.composerSuppressed)
    })),
  finalReceived: (text) =>
    set((s) => ({
      draft: joinFinal(s.draft, text),
      partial: '',
      flyoutOpen: s.flyoutOpen || (text.length > 0 && !s.composerSuppressed)
    })),
  setDraft: (text) => set({ draft: text }),
  clearTranscript: () => set({ draft: '', partial: '' }),
  setFlyoutOpen: (open) => set((s) => (s.flyoutOpen === open ? s : { flyoutOpen: open })),
  setComposerSuppressed: (on) =>
    set((s) => (s.composerSuppressed === on ? s : { composerSuppressed: on })),
  setModelStatus: (modelStatus) => set({ modelStatus }),
  setEngineError: (on) => set((s) => (s.engineError === on ? s : { engineError: on })),
  recent: [],
  setRecent: (recent) => set((s) => (s.recent === recent ? s : { recent }))
}))

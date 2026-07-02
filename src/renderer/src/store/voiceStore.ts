/**
 * Voice V1 — ephemeral dictation session state (SPEC §2: zero board-schema impact).
 * Session-state ONLY, mirroring `terminalRuntimeStore`'s role: NOTHING here is ever
 * serialized, routed into `boardSchema`, or added to `PATCHABLE_KEYS`. The capture
 * pipeline (`useVoiceCapture`) writes it; the V3 pill/flyout will read it.
 */
import { create } from 'zustand'

interface VoiceState {
  /** True while the mic capture pipeline is live (worklet wired, frames flowing). */
  capturing: boolean
  /** Normalized 0..1 RMS of the last emitted frame (drives the pill level bars). */
  level: number
  /** Silent-zeros watchdog verdict — a live all-zeros stream means the OS denied the
   *  mic without an error (electron#42714); surfaced as `mic-denied` in V3. */
  micSilent: boolean
  /** Frames forwarded to MAIN this session (e2e/devtools observability; reset on start). */
  framesSent: number
  /** The terminal board dictation targets (V3 flyout header); unused in V1. */
  activeBoardId: string | null
  captureStarted: () => void
  captureStopped: () => void
  /** One frame left for MAIN: update the level + count it. */
  frameSent: (rms: number) => void
  setMicSilent: (silent: boolean) => void
  setActiveBoard: (id: string | null) => void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  capturing: false,
  level: 0,
  micSilent: false,
  framesSent: 0,
  activeBoardId: null,
  captureStarted: () => set({ capturing: true, level: 0, micSilent: false, framesSent: 0 }),
  // framesSent survives the stop so a probe can read the session total afterwards.
  captureStopped: () => set({ capturing: false, level: 0, micSilent: false }),
  frameSent: (rms) => set((s) => ({ level: rms, framesSent: s.framesSent + 1 })),
  setMicSilent: (silent) => set((s) => (s.micSilent === silent ? s : { micSilent: silent })),
  setActiveBoard: (id) => set((s) => (s.activeBoardId === id ? s : { activeBoardId: id }))
}))

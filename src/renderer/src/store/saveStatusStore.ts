/**
 * Save-status surface (design-audit D0-8 → PERSIST-03). Originally a nullable
 * failure string so the chrome could surface a disk error instead of losing edits
 * silently; PERSIST-03 promotes it to a four-state lifecycle (idle/saving/saved/
 * error) so the user gets *positive* confirmation that work persisted, not only a
 * failure signal. AppChrome renders a quiet ambient indicator off `state`; the
 * `failure` message still drives the sticky Retry toast (the actionable surface).
 * Set by the autosave hook (and the project-switch flush path); ephemeral session
 * state — never serialized.
 */
import { create } from 'zustand'

/** Coarse save lifecycle for the ambient chrome indicator. `idle` = no save this
 *  session yet (a freshly-opened project is already on disk, so it reads as "Saved"). */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface SaveStatusState {
  /** Current lifecycle state — drives the ambient AppChrome indicator. */
  state: SaveState
  /** Human-readable description of the last failed save; null = saves healthy. */
  failure: string | null
  /** A save attempt began (autosave write in flight). */
  markSaving: () => void
  /** A save completed successfully — clears any standing failure too. */
  markSaved: () => void
  /** A save failed — records the message (drives the sticky Retry toast). */
  setSaveFailure: (message: string) => void
  /** Clear the failure without asserting a fresh success (compat / test reset). */
  clearSaveFailure: () => void
}

export const useSaveStatusStore = create<SaveStatusState>((set) => ({
  state: 'idle',
  failure: null,
  // Guarded sets: skip the swap when already in the target state so the ~1s autosave
  // cadence doesn't churn subscribers (markSaving/markSaved fire on every save attempt).
  markSaving: () => set((s) => (s.state === 'saving' ? s : { state: 'saving' })),
  markSaved: () =>
    set((s) => (s.state === 'saved' && s.failure === null ? s : { state: 'saved', failure: null })),
  setSaveFailure: (message) => set({ state: 'error', failure: message }),
  // Clearing a failure always lands on a neutral idle (it is only reached from a
  // resolved-error path or a test reset); a no-op ref-wise when already clean.
  clearSaveFailure: () => set((s) => (s.failure === null ? s : { state: 'idle', failure: null }))
}))

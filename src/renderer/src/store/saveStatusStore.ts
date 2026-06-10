/**
 * Save-failure surface (design-audit D0-8, SAVE-1 class): the last project save
 * failure, published so the app chrome can show a visible error chip instead of
 * letting a failing disk lose edits silently. Set by the autosave hook's onError
 * (and the project-switch flush path); cleared by the next successful save or a
 * successful manual retry. Ephemeral session state — never serialized.
 */
import { create } from 'zustand'

interface SaveStatusState {
  /** Human-readable description of the last failed save; null = saves healthy. */
  failure: string | null
  setSaveFailure: (message: string) => void
  clearSaveFailure: () => void
}

export const useSaveStatusStore = create<SaveStatusState>((set) => ({
  failure: null,
  setSaveFailure: (message) => set({ failure: message }),
  // Conditional set: skip the state swap when already clean so every successful
  // autosave (~1s cadence) doesn't churn subscribers.
  clearSaveFailure: () => set((s) => (s.failure === null ? s : { failure: null }))
}))

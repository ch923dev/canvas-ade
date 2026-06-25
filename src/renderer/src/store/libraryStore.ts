/**
 * Ephemeral Project Library UI state. `refreshNonce` is the "re-list" signal, bumped whenever a
 * file lands under `<project>/.canvas/` from a renderer-observable action — a screenshot saved to
 * `assets/` (BrowserBoard `takeScreenshot`) or a completed download (`useOsrWidgetEvents`); the
 * `ProjectLibraryPanel` re-fetches on the bump while it is open, so a newly-saved file appears
 * without a manual refresh. `open` is the panel's open/closed state — kept here (not in panel-local
 * `useState`) so the e2e `reset()` can close it between specs, the way it closes the Digest panel.
 * Without that path an open panel leaked across specs and occluded a later `@preview` spec's click
 * target (the cross-spec "library-panel-overlap" flake). Never serialized.
 */
import { create } from 'zustand'

interface LibraryState {
  /** Incremented on each `.canvas/` file add; the panel re-lists when it changes (while open). */
  refreshNonce: number
  requestRefresh: () => void
  /** The slide-in panel is open. Starts closed; the panel's reopen tab / ✕ toggle it. */
  open: boolean
  setOpen: (open: boolean) => void
}

export const useLibraryStore = create<LibraryState>((set) => ({
  refreshNonce: 0,
  requestRefresh: () => set((s) => ({ refreshNonce: s.refreshNonce + 1 })),
  open: false,
  setOpen: (open) => set({ open })
}))

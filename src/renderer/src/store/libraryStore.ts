/**
 * Ephemeral "re-list the Project Library" signal. Bumped whenever a file lands under
 * `<project>/.canvas/` from a renderer-observable action — a screenshot saved to `assets/`
 * (BrowserBoard `takeScreenshot`) or a completed download (`useOsrWidgetEvents`). The
 * `ProjectLibraryPanel` re-fetches on the bump while it is open, so a newly-saved file appears
 * without a manual refresh. Never serialized.
 */
import { create } from 'zustand'

interface LibraryState {
  /** Incremented on each `.canvas/` file add; the panel re-lists when it changes (while open). */
  refreshNonce: number
  requestRefresh: () => void
}

export const useLibraryStore = create<LibraryState>((set) => ({
  refreshNonce: 0,
  requestRefresh: () => set((s) => ({ refreshNonce: s.refreshNonce + 1 }))
}))

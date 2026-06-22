/**
 * File-tree UI state (S3 empty-board redesign) — ephemeral, never serialized.
 *
 * Lives in its own tiny store (NOT canvasStore, which is at the max-lines cap) and wires the
 * empty File board's "Browse files" affordance to the docked tree:
 *  - `revealNonce` — bumped to ask the auto-hide SidePanel to reveal itself.
 *  - `pendingBindId` — the empty File board that armed itself via "Browse files"; the NEXT file
 *    clicked in the tree binds INTO that board (FileTree consumes + clears it) instead of opening
 *    a separate board. A visible, cancelable "waiting" state on the board keeps it from going stale.
 */
import { create } from 'zustand'

interface FileTreeUiState {
  revealNonce: number
  pendingBindId: string | null
  /** Reveal the docked tree (bump the nonce the auto-hide SidePanel listens for), without arming
   *  a board. Mirrors the user moving onto the left-edge zone — the only way to surface the tree. */
  reveal: () => void
  /** Reveal the docked tree AND arm `boardId` to receive the next tree-file click. */
  requestBrowse: (boardId: string) => void
  /** Disarm (the board was bound, the user canceled, or a different board armed). */
  clearPendingBind: () => void
}

export const useFileTreeUiStore = create<FileTreeUiState>((set) => ({
  revealNonce: 0,
  pendingBindId: null,
  reveal: () => set((s) => ({ revealNonce: s.revealNonce + 1 })),
  requestBrowse: (boardId) =>
    set((s) => ({ revealNonce: s.revealNonce + 1, pendingBindId: boardId })),
  clearPendingBind: () => set((s) => (s.pendingBindId === null ? s : { pendingBindId: null }))
}))

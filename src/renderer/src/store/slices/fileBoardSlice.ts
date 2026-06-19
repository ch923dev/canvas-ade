/**
 * File-board slice — opening files as boards, plus the PEEK/PIN discipline (file-tree S6).
 *
 * VS Code rations one editor surface with "preview tabs": a single-click opens a reused, italicised
 * preview tab; double-clicking or editing pins it. The canvas has infinite surface, so the hazard is
 * the opposite — a new board per click litters the scene. We re-express the same discipline spatially:
 *
 *   - `peekBoardId` is the id of the ONE reusable "peek" board (or null). A board is a PEEK board ⟺
 *     `id === peekBoardId`; FileBoard renders that one ghosted (dashed) and rebinds it on each tree
 *     single-click, so browsing never spawns a second board.
 *   - PINNING (double-click in the tree, the first edit, or a drag-out) clears `peekBoardId` → the
 *     board becomes a normal, permanent board and the next single-click spawns a fresh peek.
 *
 * `peekBoardId` is EPHEMERAL (never serialized — `toObject` whitelists `{schemaVersion, viewport,
 * boards}`), so this needs no schema bump. A peek REBIND is a non-recording `set` (browsing the tree
 * must not pile up undo steps); only the initial spawn (via `openFileBoard` → `addBoard`) records.
 *
 * Lives in a slice (not canvasStore.ts, which is at the max-lines cap) — `openFileBoard` moved here
 * too, since it is file-board logic. Uses only `set`/`get`; no history deps (addBoard records its own
 * step, and peek rebinds are intentionally non-undoable).
 */
import type { CanvasState } from '../canvasStore'
import type { SetCanvasState, GetCanvasState } from './sliceTypes'
import { DEFAULT_BOARD_SIZE } from '../../lib/boardSchema'

export function createFileBoardSlice(
  set: SetCanvasState,
  get: GetCanvasState
): Pick<CanvasState, 'peekBoardId' | 'openFileBoard' | 'peekFile' | 'pinBoard' | 'pinFile'> {
  /** World-space TOP-LEFT near the viewport centre for a freshly opened File board. */
  const centerSlot = (): { x: number; y: number } => {
    const s = DEFAULT_BOARD_SIZE.file
    const vp = get().viewport
    const { innerWidth: w = 1280, innerHeight: h = 800 } = globalThis
    return vp
      ? { x: (w / 2 - vp.x) / vp.zoom - s.w / 2, y: (h / 2 - vp.y) / vp.zoom - s.h / 2 }
      : { x: -s.w / 2, y: -s.h / 2 }
  }

  return {
    peekBoardId: null,

    openFileBoard: (relPath, at) => {
      // Re-focus an already-open File board for the EXACT same path instead of duplicating. A tree
      // click (no `at`) ALSO requests a camera focus so an off-screen board is brought into view; a
      // canvas drop (`at` given) only selects + places under the cursor.
      const existing = get().boards.find((b) => b.type === 'file' && b.path === relPath)
      if (existing) get().selectBoard(existing.id)
      const id = existing
        ? existing.id
        : get().addBoard('file', at ?? centerSlot(), { path: relPath })
      if (!at) set({ pendingFocusId: id })
      return id
    },

    peekFile: (relPath) => {
      const st = get()
      // A board already showing this file → activate it (VS Code: clicking an open file focuses its
      // tab, never spawns a preview). Covers both a pinned board AND the peek already on this path.
      const open = st.boards.find((b) => b.type === 'file' && b.path === relPath)
      if (open) {
        st.selectBoard(open.id)
        set({ pendingFocusId: open.id })
        return
      }
      // A live peek board exists → REBIND it (non-recording: browsing must not pile up undo steps).
      const peekId = st.peekBoardId
      const peek = peekId ? st.boards.find((b) => b.id === peekId) : undefined
      if (peek) {
        set((s) => ({
          boards: s.boards.map((b) => (b.id === peekId ? { ...b, path: relPath } : b)),
          pendingFocusId: peekId
        }))
        st.selectBoard(peekId)
        return
      }
      // No peek yet → spawn the one peek board (openFileBoard selects + focuses) and mark it.
      set({ peekBoardId: st.openFileBoard(relPath) })
    },

    pinBoard: (id) => set((s) => (s.peekBoardId === id ? { peekBoardId: null } : s)),

    pinFile: (relPath) => {
      const st = get()
      const existing = st.boards.find((b) => b.type === 'file' && b.path === relPath)
      if (existing) {
        st.pinBoard(existing.id) // promotes the peek if this was it; otherwise a harmless no-op
        st.selectBoard(existing.id)
        set({ pendingFocusId: existing.id })
        return
      }
      st.openFileBoard(relPath) // spawn a permanent (un-marked) board — pinned by construction
    }
  }
}

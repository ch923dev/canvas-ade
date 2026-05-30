/**
 * Canvas store — app / ephemeral state (Zustand).
 *
 * Holds the live boards plus transient UI state (selection, active tool). Board
 * *data* shapes + (de)serialization live in `lib/boardSchema` (pure, tested
 * separately); this store is the stateful, id-generating layer the canvas (2.0-C)
 * and app chrome (2.0-D) drive. Camera state stays with React Flow; persistence
 * (file I/O) is Phase 3 — but `toObject()`/`loadObject()` already bridge to the
 * versioned document so saving is a thin wrapper later.
 */
import { create } from 'zustand'
import {
  type Board,
  type BoardType,
  type CanvasDoc,
  createBoard,
  fromObject,
  toObject,
  MIN_BOARD_SIZE
} from '../lib/boardSchema'
import { recordPast, applyUndo, applyRedo } from './history'

/** Active dock tool: the neutral select tool or a pending add-board type. */
export type Tool = 'select' | BoardType

export interface CanvasState {
  boards: Board[]
  selectedId: string | null
  tool: Tool
  /** Undo/redo rails (internal — drive via beginChange/undo/redo, don't read directly). */
  past: Board[][]
  future: Board[][]

  /** Add a board of `type` at a world position; selects it; returns its new id. */
  addBoard: (type: BoardType, at: { x: number; y: number }) => string
  /** Remove a board; clears the selection if it was the selected one. */
  removeBoard: (id: string) => void
  /** Shallow-merge a partial patch into one board (move, rename, per-type props). */
  updateBoard: (id: string, patch: Partial<Board>) => void
  /** Resize a board, clamped to the minimum board size. */
  resizeBoard: (id: string, w: number, h: number) => void
  /**
   * Grow a board's height to fit measured content (checklist auto-grow). UNTRACKED,
   * layout-only: never touches the undo/redo rails, so a measured height bump on
   * mount/render can neither push an undo checkpoint nor wipe an armed redo branch
   * (#BUG-024). Only ever grows; a no-op when the board is already tall enough.
   */
  growBoardHeight: (id: string, h: number) => void
  selectBoard: (id: string | null) => void
  setTool: (tool: Tool) => void
  /** Snapshot the current boards for undo (call at the start of a discrete edit). */
  beginChange: () => void
  undo: () => void
  redo: () => void

  /** Snapshot the canvas as a versioned document (Phase 3 persistence bridge). */
  toObject: () => CanvasDoc
  /** Replace all boards from a document (migrated); clears the selection. */
  loadObject: (doc: unknown) => void
}

const newId = (): string => crypto.randomUUID()

/** Cascade step (world px) per occupied slot + a guard cap on the walk. */
const CASCADE_STEP = 28
const CASCADE_MAX = 24

/**
 * Nudge a new board's top-left off any board already sitting at (≈) the same spot
 * so repeated centered adds don't fully stack (#42). Deterministic: walk a fixed
 * diagonal step until a free slot is found. The cap keeps the walk bounded if a
 * canvas is pathologically dense at that exact diagonal.
 */
function cascadePosition(boards: Board[], at: { x: number; y: number }): { x: number; y: number } {
  const occupied = (x: number, y: number): boolean =>
    boards.some((b) => Math.abs(b.x - x) < 1 && Math.abs(b.y - y) < 1)
  let x = at.x
  let y = at.y
  for (let i = 1; occupied(x, y) && i <= CASCADE_MAX; i++) {
    x = at.x + i * CASCADE_STEP
    y = at.y + i * CASCADE_STEP
  }
  return { x, y }
}

/**
 * Patch keys a board of each type may accept — id/type are never patchable, and an
 * off-type field (e.g. `url`) must never land on a board it doesn't belong to (that
 * would forge a cross-type hybrid the discriminated union forbids). The common,
 * geometry/title keys are mergeable on every type.
 */
const COMMON_KEYS = ['x', 'y', 'w', 'h', 'title', 'z'] as const
const PATCHABLE_KEYS: Record<BoardType, readonly string[]> = {
  terminal: [...COMMON_KEYS, 'shell', 'launchCommand', 'cwd', 'port'],
  browser: [...COMMON_KEYS, 'url', 'viewport'],
  planning: [...COMMON_KEYS, 'elements']
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  boards: [],
  selectedId: null,
  tool: 'select',
  past: [],
  future: [],

  addBoard: (type, at) => {
    const id = newId()
    const pos = cascadePosition(get().boards, at)
    const board = createBoard(type, { id, x: pos.x, y: pos.y })
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: [...s.boards, board],
      selectedId: id
    }))
    return id
  },

  removeBoard: (id) =>
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: s.boards.filter((b) => b.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId
    })),

  updateBoard: (id, patch) =>
    set((s) => {
      // A patch may carry props (move, rename, per-type fields) but MUST NOT change
      // a board's identity or type, nor smuggle an off-type field (e.g. a `url`
      // landing on a terminal board) — that would forge a cross-type hybrid the
      // discriminated union forbids. So we keep only the keys valid for the target
      // board's type before the merge, which keeps the cast sound.
      const src = patch as Record<string, unknown>
      let changed = false
      const boards = s.boards.map((b) => {
        if (b.id !== id) return b
        const allowed = PATCHABLE_KEYS[b.type]
        const safe: Record<string, unknown> = {}
        for (const key of allowed) {
          if (key in src) safe[key] = src[key]
        }
        changed = true
        return { ...b, ...safe } as Board
      })
      if (!changed) return s
      // A live edit invalidates any armed redo branch (else redo could clobber it).
      return s.future.length ? { boards, future: [] } : { boards }
    }),

  resizeBoard: (id, w, h) =>
    set((s) => {
      let changed = false
      const boards = s.boards.map((b) => {
        if (b.id !== id) return b
        changed = true
        return { ...b, w: Math.max(MIN_BOARD_SIZE.w, w), h: Math.max(MIN_BOARD_SIZE.h, h) }
      })
      if (!changed) return s
      return s.future.length ? { boards, future: [] } : { boards }
    }),

  growBoardHeight: (id, h) =>
    set((s) => {
      // Layout-only, untracked: only-grow, and NEVER touch past/future. A measured
      // content-fit bump must not pollute or wipe undo/redo history (#BUG-024).
      let changed = false
      const boards = s.boards.map((b) => {
        if (b.id !== id || b.h >= h) return b
        changed = true
        return { ...b, h }
      })
      return changed ? { boards } : s
    }),

  selectBoard: (id) => set({ selectedId: id }),
  setTool: (tool) => set({ tool }),
  beginChange: () =>
    set((s) => {
      // No change since the last checkpoint (boards array ref unchanged) → skip,
      // so a no-op gesture doesn't push a duplicate snapshot.
      if (s.past[s.past.length - 1] === s.boards) return s
      // Take the pre-edit snapshot but do NOT clear the redo branch here (Bug #7).
      // beginChange fires at GESTURE START, before we know whether the gesture will
      // commit anything — a zero-movement titlebar/resize-handle click or a degenerate
      // arrow/pen tap calls it but mutates nothing. The redo branch is correctly
      // invalidated by the actual mutation: updateBoard/resizeBoard clear `future` only
      // when boards truly change. Clearing it here too would wipe an armed redo on a
      // no-op gesture performed right after an undo (the guard above misses the
      // post-undo case, where past tail !== boards even though boards is unchanged).
      return { past: recordPast(s.past, s.boards) }
    }),
  undo: () =>
    set((s) => {
      const r = applyUndo(s.past, s.boards, s.future)
      return r ? { boards: r.present, past: r.past, future: r.future, selectedId: null } : s
    }),
  redo: () =>
    set((s) => {
      const r = applyRedo(s.past, s.boards, s.future)
      return r ? { boards: r.present, past: r.past, future: r.future, selectedId: null } : s
    }),

  toObject: () => toObject(get().boards),
  loadObject: (doc) =>
    set({ boards: fromObject(doc).boards, selectedId: null, past: [], future: [] })
}))

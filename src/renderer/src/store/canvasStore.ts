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

export const useCanvasStore = create<CanvasState>((set, get) => ({
  boards: [],
  selectedId: null,
  tool: 'select',
  past: [],
  future: [],

  addBoard: (type, at) => {
    const id = newId()
    const board = createBoard(type, { id, x: at.x, y: at.y })
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
    set((s) => ({
      boards: s.boards.map((b) => (b.id === id ? ({ ...b, ...patch } as Board) : b))
    })),

  resizeBoard: (id, w, h) =>
    set((s) => ({
      boards: s.boards.map((b) =>
        b.id === id
          ? { ...b, w: Math.max(MIN_BOARD_SIZE.w, w), h: Math.max(MIN_BOARD_SIZE.h, h) }
          : b
      )
    })),

  selectBoard: (id) => set({ selectedId: id }),
  setTool: (tool) => set({ tool }),
  beginChange: () =>
    set((s) => {
      // No change since the last checkpoint (boards array ref unchanged) → skip,
      // so a no-op gesture doesn't push a duplicate snapshot or wipe the redo branch.
      if (s.past[s.past.length - 1] === s.boards) return s
      return { past: recordPast(s.past, s.boards), future: [] }
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
  loadObject: (doc) => set({ boards: fromObject(doc).boards, selectedId: null })
}))

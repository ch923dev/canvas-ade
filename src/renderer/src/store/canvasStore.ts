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
  type CanvasViewport,
  createBoard,
  fromObject,
  toObject,
  MIN_BOARD_SIZE,
  DEFAULT_BOARD_SIZE
} from '../lib/boardSchema'
import { recordPast, applyUndo, applyRedo } from './history'
import { nextViewport } from '../lib/viewportCycle'
import { tidyLayout, type TidyMode } from '../lib/tidyLayout'
import { tileLayout, type TileTemplate } from '../lib/tileLayout'

/** Active dock tool: the neutral select tool or a pending add-board type. */
export type Tool = 'select' | BoardType

export type ProjectStatus = 'welcome' | 'loading' | 'open' | 'error'
export interface ProjectState {
  dir: string | null
  name: string | null
  status: ProjectStatus
  error?: string
}
/** Result of a project open/create IPC call (mirrors preload `ProjectResult`). */
export type OpenResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }
/**
 * A recent-project entry (mirrors preload `RecentProject`). Re-declared here so
 * renderer UI (welcome screen, project switcher) can import it from the store
 * instead of reaching across to the preload module (outside the web tsconfig glob).
 */
export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

export interface CanvasState {
  boards: Board[]
  selectedId: string | null
  tool: Tool
  /** Undo/redo rails (internal — drive via beginChange/undo/redo, don't read directly). */
  past: Board[][]
  future: Board[][]
  /** Persisted camera transform (null = not yet captured / fit on load). */
  viewport: CanvasViewport | null
  /** Current project lifecycle (welcome/loading/open/error). */
  project: ProjectState
  /** Apply an open/create IPC result: load on ok, set error otherwise (no clobber). */
  applyOpenResult: (r: OpenResult) => void
  /** Mark the project as loading (suppresses autosave mid-switch). */
  setProjectLoading: () => void

  /** Add a board of `type` at a world position; selects it; returns its new id. */
  addBoard: (type: BoardType, at: { x: number; y: number }) => string
  /** Remove a board; clears the selection if it was the selected one. */
  removeBoard: (id: string) => void
  /** Clone a board (geometry + state) offset 36px, select the copy; one undo step. Returns the new id (null if the source is gone). */
  duplicateBoard: (id: string) => string | null
  /** Shallow-merge a partial patch into one board (move, rename, per-type props). */
  updateBoard: (id: string, patch: Partial<Board>) => void
  /** Resize a board, clamped to the minimum board size. */
  resizeBoard: (id: string, w: number, h: number) => void
  /**
   * Auto-tidy: repack every board with the chosen layout `mode` (default 'smart' —
   * link-aware grouping). `aspect` steers the 'grid' mode toward the viewport ratio.
   * One tracked undo step; a no-op for <2 boards or when nothing actually moves.
   */
  tidyBoards: (mode?: TidyMode, aspect?: number) => void
  /**
   * Window-manager TILING: resize + move every board to fill a zone of `area` (a world-space,
   * pane-aspect block the caller frames after). w/h clamped to the board minimum.
   * `record` (default true) takes one undo step; pass `false` for live reflow on window resize
   * (UNTRACKED — never touches undo/redo, like growBoardHeight, so a resize storm can't spam it).
   */
  tileBoards: (
    template: TileTemplate,
    area: { x: number; y: number; w: number; h: number },
    record?: boolean
  ) => void
  /**
   * Grow a board's height to fit measured content (checklist auto-grow). UNTRACKED,
   * layout-only: never touches the undo/redo rails, so a measured height bump on
   * mount/render can neither push an undo checkpoint nor wipe an armed redo branch
   * (#BUG-024). Only ever grows; a no-op when the board is already tall enough.
   */
  growBoardHeight: (id: string, h: number) => void
  /** Set the camera transform. UNTRACKED — never touches undo/redo (like growBoardHeight). */
  setViewport: (vp: CanvasViewport) => void
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

/**
 * The boards snapshot that the undo stack already reflects — either the value last
 * pushed onto `past`, or the present `boards` after an undo/redo. `beginChange` skips
 * recording when the current `boards` is this same reference, so a no-op gesture never
 * pushes a duplicate snapshot. This is what the in-store `past[last] === boards` guard
 * MISSES after an undo: undo pops the tail and sets `boards` to it, so the new past tail
 * is the entry *before* it (≠ boards) even though boards is unchanged — without this ref
 * a post-undo no-op beginChange would push a phantom snapshot (#BUG M3).
 */
let lastRecorded: Board[] | null = null

/**
 * Terminal board ids that must mount IDLE (no PTY auto-spawn): terminals RESTORED from
 * disk (`loadObject`/`applyOpenResult`) and DUPLICATED clones (`duplicateBoard`). A
 * terminal added FRESH this session (`addBoard`) is NOT here, so it auto-spawns. The set
 * is NON-consuming on read — a restored terminal stays idle across LOD remounts; an id is
 * removed only when the user explicitly Starts it (`clearIdleOnMount`), so a later
 * in-session respawn (config change / restart) of an already-started terminal spawns
 * normally (the bug the one-shot predecessor caused). CLAUDE.md LOCKED rule: "restored
 * terminals are idle". Module-scoped (mirrors `lastRecorded`); never persisted.
 */
const idleOnMountIds = new Set<string>()

/** Whether `id` must mount idle (restored/duplicated, not yet started). Non-consuming. */
export function isIdleOnMount(id: string): boolean {
  return idleOnMountIds.has(id)
}

/** Drop the idle flag — called when the user explicitly Starts a restored terminal, so a
 *  subsequent in-session respawn / remount of that board spawns normally. */
export function clearIdleOnMount(id: string): void {
  idleOnMountIds.delete(id)
}

/** Mark every terminal in a freshly-loaded doc as idle-on-mount (restore path). */
function markRestoredIdle(boards: Board[]): void {
  idleOnMountIds.clear()
  for (const b of boards) if (b.type === 'terminal') idleOnMountIds.add(b.id)
}

/** Gap (world px) kept between boards when auto-placing a new one. */
const PLACE_GAP = 28
/** How many expanding rings the free-slot search probes before giving up. */
const PLACE_RINGS = 16
/** Search directions for the outward spiral: right/down/left/up first, then diagonals. */
const RING_DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1]
] as const

/**
 * Find a top-left for a new board of `size` near `at` (the viewport centre) that does
 * NOT overlap — with a PLACE_GAP margin — any board already on the canvas, so a freshly
 * added board never lands on top of and hides an existing one (the canvas stays tidy).
 * Returns `at` when it is already clear; otherwise searches outward in expanding rings
 * (one board-step per ring, nearest direction first) and returns the closest free slot,
 * so the new board tucks into open space beside the existing cluster instead of covering
 * it. Deterministic (no randomness) so undo/redo + persistence stay reproducible.
 */
function freeSlot(
  boards: Board[],
  at: { x: number; y: number },
  size: { w: number; h: number }
): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean =>
    boards.some(
      (b) =>
        x < b.x + b.w + PLACE_GAP &&
        b.x < x + size.w + PLACE_GAP &&
        y < b.y + b.h + PLACE_GAP &&
        b.y < y + size.h + PLACE_GAP
    )
  if (!overlaps(at.x, at.y)) return at
  const strideX = size.w + PLACE_GAP
  const strideY = size.h + PLACE_GAP
  for (let ring = 1; ring <= PLACE_RINGS; ring++) {
    for (const [dx, dy] of RING_DIRS) {
      const x = at.x + dx * ring * strideX
      const y = at.y + dy * ring * strideY
      if (!overlaps(x, y)) return { x, y }
    }
  }
  return { x: at.x + PLACE_GAP, y: at.y + PLACE_GAP }
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
  browser: [...COMMON_KEYS, 'url', 'viewport', 'previewSourceId'],
  planning: [...COMMON_KEYS, 'elements']
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  boards: [],
  selectedId: null,
  tool: 'select',
  past: [],
  future: [],
  viewport: null,
  project: { dir: null, name: null, status: 'welcome' },

  addBoard: (type, at) => {
    const id = newId()
    const pos = freeSlot(get().boards, at, DEFAULT_BOARD_SIZE[type])
    const board = createBoard(type, { id, x: pos.x, y: pos.y })
    // A fresh, this-session add is NOT idle-on-mount, so a Terminal board auto-spawns
    // on mount. Only restored/duplicated boards are flagged idle (M-1).
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
      boards: s.boards
        .filter((b) => b.id !== id)
        // Clear a preview link whose source terminal was just removed (Slice C′).
        .map((b) =>
          b.type === 'browser' && b.previewSourceId === id
            ? { ...b, previewSourceId: undefined }
            : b
        ),
      selectedId: s.selectedId === id ? null : s.selectedId
    })),

  duplicateBoard: (id) => {
    const src = get().boards.find((b) => b.id === id)
    if (!src) return null
    const cloneId = newId()
    const clone = structuredClone(src)
    clone.id = cloneId
    clone.x = src.x + 36
    clone.y = src.y + 36
    delete clone.z // re-stacks on top via array order, like a freshly added board
    if (clone.type === 'browser') {
      clone.viewport = nextViewport(clone.viewport)
      // Keep `previewSourceId` (copied by structuredClone): duplicating a Browser that's
      // linked to a terminal should leave the copy linked to the SAME terminal, so both
      // previews (e.g. Desktop + Mobile of one dev server) track that server and each
      // draws its own connector arrow. The link is still cleared if that terminal is
      // later removed (removeBoard). Primary use is forking a preview to a 2nd viewport.
    }
    if (clone.type === 'planning') {
      clone.elements = clone.elements.map((e) => ({ ...structuredClone(e), id: newId() }))
    }
    // A duplicated terminal starts IDLE — cloning must not silently spin up a second
    // agent (M-1). The user starts it explicitly via the Start affordance.
    if (clone.type === 'terminal') idleOnMountIds.add(cloneId)
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: [...s.boards, clone],
      selectedId: cloneId
    }))
    return cloneId
  },

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
        let diff = false
        for (const key of allowed) {
          if (key in src) {
            safe[key] = src[key]
            // Reference/value compare: a patch re-applying identical values must NOT
            // mint a new boards ref or clear the redo branch (STATE-2). New-array refs
            // (e.g. elements) on a real edit still differ, so genuine edits register.
            if ((b as unknown as Record<string, unknown>)[key] !== src[key]) diff = true
          }
        }
        if (!diff) return b
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
        const nw = Math.max(MIN_BOARD_SIZE.w, w)
        const nh = Math.max(MIN_BOARD_SIZE.h, h)
        // No-op resize (clamped to the same w/h) must not clear redo / re-ref (STATE-2).
        if (nw === b.w && nh === b.h) return b
        changed = true
        return { ...b, w: nw, h: nh }
      })
      if (!changed) return s
      return s.future.length ? { boards, future: [] } : { boards }
    }),

  tidyBoards: (mode, aspect) =>
    set((s) => {
      // Nothing to organise with fewer than two boards.
      if (s.boards.length < 2) return s
      // Board carries id/x/y/w/h/type (+ viewport/previewSourceId on browsers) — exactly
      // the fields tidyLayout reads for smart/by-type grouping.
      const pos = new Map(tidyLayout(s.boards, { mode, aspect }).map((p) => [p.id, p]))
      let changed = false
      const boards = s.boards.map((b) => {
        const p = pos.get(b.id)
        if (!p || (p.x === b.x && p.y === b.y)) return b
        changed = true
        return { ...b, x: p.x, y: p.y }
      })
      // Already tidy → no-op (don't push a phantom undo step / invalidate redo).
      if (!changed) return s
      // The tidied present IS the history-reflected state — record it so a following
      // no-op beginChange (a zero-movement titlebar/resize click) recognises it and does
      // NOT push a phantom snapshot. Without this, a no-op gesture after tidy leaves a
      // dead undo step (Undo #1 a no-op, Undo #2 needed to reverse tidy) — the same
      // defect class the undo/redo paths guard via `lastRecorded` (#BUG M3).
      lastRecorded = boards
      // One undo step for the whole re-pack; a real edit invalidates the redo branch.
      return { past: recordPast(s.past, s.boards), future: [], boards }
    }),

  tileBoards: (template, area, record = true) =>
    set((s) => {
      if (s.boards.length < 1) return s
      const rects = new Map(tileLayout(s.boards, template, area).map((r) => [r.id, r]))
      let changed = false
      const boards = s.boards.map((b) => {
        const r = rects.get(b.id)
        if (!r) return b
        // Tiling sets SIZE too; clamp to the board minimum so a tiny zone can't make a
        // degenerate board (the resizeBoard floor, applied inline here).
        const w = Math.max(MIN_BOARD_SIZE.w, r.w)
        const h = Math.max(MIN_BOARD_SIZE.h, r.h)
        if (b.x === r.x && b.y === r.y && b.w === w && b.h === h) return b
        changed = true
        return { ...b, x: r.x, y: r.y, w, h }
      })
      if (!changed) return s
      // Live reflow (window resize): layout-only, leave undo/redo untouched (like
      // growBoardHeight) so a resize storm can't flood the history.
      // Deliberately do NOT update `lastRecorded` here. It must keep meaning "the boards the
      // undo stack reflects" — and the stack reflects the PRE-tile snapshot, not this reflow.
      // Setting it to `boards` would make the next beginChange think the reflowed layout is
      // already in history and SKIP the pre-drag checkpoint, so a real drag after a reflow
      // couldn't be undone granularly (undo would jump past it to pre-tile). The only cost of
      // leaving it stale is a phantom no-op step on a ZERO-movement titlebar press after a
      // reflow — the same tolerated edge as addBoard/removeBoard (Bug #7 / #BUG M3). A real
      // drag stays correctly undoable. Do not "fix" by syncing lastRecorded.
      if (!record) return { boards }
      // Tracked apply: one undo step, sync lastRecorded so a no-op gesture after tiling
      // doesn't push a phantom snapshot (#BUG M3), invalidate the redo branch.
      lastRecorded = boards
      return { past: recordPast(s.past, s.boards), future: [], boards }
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

  setViewport: (vp) =>
    set((s) => {
      // Camera frames fire continuously; skip when the transform is unchanged so a
      // no-op frame doesn't re-set state and notify every store subscriber (#BUG L2).
      const cur = s.viewport
      if (cur && cur.x === vp.x && cur.y === vp.y && cur.zoom === vp.zoom) return s
      return { viewport: vp }
    }),

  selectBoard: (id) => set({ selectedId: id }),
  setTool: (tool) => set({ tool }),
  beginChange: () =>
    set((s) => {
      // No change since the last checkpoint → skip, so a no-op gesture doesn't push a
      // duplicate snapshot. Two cases of "unchanged": the boards array ref matches the
      // past tail (normal post-edit), OR it matches `lastRecorded` — the present left by
      // an undo/redo. The past-tail check alone MISSES the post-undo case (#BUG M3):
      // undo pops the tail, so `boards` (the popped value) ≠ the new past tail even
      // though boards is unchanged → a no-op beginChange would push a phantom snapshot.
      if (s.past[s.past.length - 1] === s.boards || lastRecorded === s.boards) return s
      // Take the pre-edit snapshot but do NOT clear the redo branch here (Bug #7).
      // beginChange fires at GESTURE START, before we know whether the gesture will
      // commit anything — a zero-movement titlebar/resize-handle click or a degenerate
      // arrow/pen tap calls it but mutates nothing. The redo branch is correctly
      // invalidated by the actual mutation: updateBoard/resizeBoard clear `future` only
      // when boards truly change.
      lastRecorded = s.boards
      return { past: recordPast(s.past, s.boards) }
    }),
  undo: () =>
    set((s) => {
      const r = applyUndo(s.past, s.boards, s.future)
      if (!r) return s
      // The present after undo IS the history-reflected state — record it so a following
      // no-op beginChange recognizes it and doesn't push a phantom snapshot (#BUG M3).
      lastRecorded = r.present
      return { boards: r.present, past: r.past, future: r.future, selectedId: null }
    }),
  redo: () =>
    set((s) => {
      const r = applyRedo(s.past, s.boards, s.future)
      if (!r) return s
      lastRecorded = r.present
      return { boards: r.present, past: r.past, future: r.future, selectedId: null }
    }),

  toObject: () => toObject(get().boards, get().viewport),
  loadObject: (doc) => {
    const d = fromObject(doc)
    // Clear the dedup ref: it points at the pre-load boards array; a fresh project's
    // history starts empty, so a dangling ref must not survive the load (#BUG M3 hygiene).
    lastRecorded = null
    // Disk-restored terminals must start IDLE (no auto-spawn / no launchCommand on
    // reopen) — flag every loaded terminal idle-on-mount (M-1).
    markRestoredIdle(d.boards)
    set({ boards: d.boards, viewport: d.viewport, selectedId: null, past: [], future: [] })
  },
  setProjectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
  applyOpenResult: (r) => {
    if (!r.ok) {
      set((s) => ({ project: { ...s.project, status: 'error', error: r.error } }))
      return
    }
    const d = fromObject(r.doc)
    // Clear the dedup ref (see loadObject): the opened project's history starts empty.
    lastRecorded = null
    // Restored terminals start idle — flag every loaded terminal idle-on-mount (M-1).
    markRestoredIdle(d.boards)
    set({
      boards: d.boards,
      viewport: d.viewport,
      selectedId: null,
      past: [],
      future: [],
      project: { dir: r.dir, name: r.name, status: 'open' }
    })
  }
}))

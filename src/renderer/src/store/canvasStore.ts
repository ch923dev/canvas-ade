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
  type Connector,
  type ConnectorKind,
  type NamedGroup,
  createBoard,
  fromObject,
  toObject,
  previewConnectorsFor,
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

/**
 * One undo/redo checkpoint: boards + connectors + groups captured together so a single
 * step covers a change to any combination (e.g. removeBoard + its incident connectors +
 * its group memberships). The undo rail was widened from `Board[]` to include connectors
 * when M2 added connectors (Decision C), and widened again to include groups (v6).
 */
export interface CanvasSnapshot {
  boards: Board[]
  connectors: Connector[]
  groups: NamedGroup[]
}

export interface CanvasState {
  boards: Board[]
  /**
   * Typed board↔board connectors (M2). Holds ORCHESTRATION connectors in memory; preview
   * connectors are derived from `previewSourceId` on save and folded back on load
   * (Decision B), so they never live here. Rides the undo rail with `boards`.
   */
  connectors: Connector[]
  /** Named board groups (v6). Rides the undo rail with boards + connectors. */
  groups: NamedGroup[]
  selectedId: string | null
  /**
   * Full multi-selection set (marquee / shift-click). `selectedId` is the PRIMARY —
   * the last id added — kept in sync as `selectedIds[selectedIds.length - 1] ?? null`
   * so single-select consumers (preview liveness, full view) are unchanged. Ephemeral:
   * never serialized (scene/session split), reset to [] on load/undo like selectedId.
   */
  selectedIds: string[]
  tool: Tool
  /** Undo/redo rails (internal — drive via beginChange/undo/redo, don't read directly). */
  past: CanvasSnapshot[]
  future: CanvasSnapshot[]
  /** Persisted camera transform (null = not yet captured / fit on load). */
  viewport: CanvasViewport | null
  /** Current project lifecycle (welcome/loading/open/error). */
  project: ProjectState
  /**
   * Apply an open/create IPC result: load on ok, set error otherwise (no clobber). Async
   * because on a deep-validation throw it retries the project's `canvas.json.bak` over IPC
   * (`project.reopenFromBak`) before giving up — `.bak` loads → recover to 'open', else
   * fall through to 'error' (T5). Callers must handle the returned promise (await / chain).
   */
  applyOpenResult: (r: OpenResult) => Promise<void>
  /** Mark the project as loading (suppresses autosave mid-switch). */
  setProjectLoading: () => void

  /**
   * Add a board of `type` at a world position; selects it; returns its id. `opts.id`
   * injects a caller-minted id (the MCP `spawn_board` path mints the id in MAIN so
   * the tool can return it to the agent); omitted → the store mints one.
   */
  addBoard: (
    type: BoardType,
    at: { x: number; y: number },
    opts?: { id?: string; size?: { w: number; h: number }; exact?: boolean }
  ) => string
  /** Remove a board; clears the selection if it was the selected one. */
  removeBoard: (id: string) => void
  /** Clone a board (geometry + state) offset 36px, select the copy; one undo step. Returns the new id (null if the source is gone). */
  duplicateBoard: (id: string) => string | null
  /**
   * Add a connector between two boards (M2). Rejects a self-link, a missing endpoint,
   * or an exact duplicate (same source+target+kind) — returns the new id, or null when
   * rejected. One tracked undo step; leaves `boards` untouched.
   */
  addConnector: (sourceId: string, targetId: string, kind: ConnectorKind) => string | null
  /** Remove a connector by id (one tracked step). A no-op for an unknown id. */
  removeConnector: (id: string) => void
  /** Create a named group over `boardIds`; returns the new id. One tracked undo step. */
  addGroup: (name: string, boardIds: string[]) => string
  /** Remove a group record (boards untouched). One tracked step; no-op for an unknown id. */
  removeGroup: (id: string) => void
  /** Rename a group. One tracked step; no-op for an unknown id or unchanged name. */
  renameGroup: (id: string, name: string) => void
  /** Union boards into a group (dedup). One tracked step; no-op if nothing new. */
  addBoardsToGroup: (id: string, boardIds: string[]) => void
  /** Remove one board from a group. One tracked step; no-op if not a member. */
  removeBoardFromGroup: (id: string, boardId: string) => void
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
  /** Toggle one board in/out of the multi-selection (shift-click). Primary = last id. */
  toggleSelect: (id: string) => void
  /** Replace the whole multi-selection (marquee). Primary = last id, or null when empty. */
  setSelection: (ids: string[]) => void
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
 * The snapshot the undo stack already reflects — either the value last pushed onto
 * `past`, or the present {boards,connectors} after an undo/redo. `beginChange` skips
 * recording when the current present matches this (by boards AND connectors ref), so a
 * no-op gesture never pushes a duplicate snapshot. This is what the in-store
 * `past[last] === present` guard MISSES after an undo: undo pops the tail and sets the
 * present to it, so the new past tail is the entry *before* it (≠ present) even though
 * the present is unchanged — without this ref a post-undo no-op beginChange would push a
 * phantom snapshot (#BUG M3). Widened from `Board[]` to a snapshot when M2 added
 * connectors (memory `undo-lastrecorded-phantom`).
 */
let lastRecorded: CanvasSnapshot | null = null

/**
 * True when `snap` is the snapshot the present state still reflects — boards, connectors,
 * AND groups refs all match. Used by `beginChange` to skip phantom checkpoints. A
 * connector-only or groups-only change mints a new ref (boards unchanged), so comparing
 * boards alone would wrongly treat it as "unchanged" — all three refs must match.
 */
function sameSnapshot(snap: CanvasSnapshot | null | undefined, s: CanvasState): boolean {
  return (
    !!snap &&
    snap.boards === s.boards &&
    snap.connectors === s.connectors &&
    snap.groups === s.groups
  )
}

/**
 * Apply a self-contained board mutation as ONE tracked undo step. `next` is the
 * already-computed next boards array, or the SAME reference / null to signal "no change"
 * (push nothing, leave undo/redo untouched). Centralizes the `recordPast` + future-clear
 * the five tracked actions each hand-rolled. Pure: takes state, returns a partial — side
 * values (a new id) are computed by the caller.
 *
 * `opts.reflectPresent` is REQUIRED (not optional) — every caller must make the layout-vs-
 * mutation decision explicitly so a future tracked action can't silently inherit the wrong
 * one. `true` marks the NEW present as the state the undo stack already reflects
 * (`lastRecorded = next`) so a following no-op gesture's beginChange skips a phantom snapshot
 * — BUT it also makes the next *real* gesture's beginChange skip its pre-edit checkpoint, so
 * a move right after is coalesced into THIS step (undo jumps back past it). Only bulk LAYOUT
 * ops (tidy/tile) pass `true`: that coalescing reads as "tidy, then nudge = one logical step",
 * an accepted tradeoff. add/remove/duplicate pass `false` — a board's first move must stay
 * granularly undoable to the add-position. Their post-no-op phantom is the TOLERATED edge
 * (#BUG M3); a store-layer flag can't close it without breaking granular move-undo (proven by
 * the undo/redo suite) — that needs a gesture-layer lazy-checkpoint, see `beginChange`.
 *
 * Returns a `Partial<CanvasState>` patch on a real change, or the full `s` (a same-ref no-op
 * merge) when `next` is null / unchanged — hence the `| CanvasState` in the return type.
 * `selectedId` is conditionally spread: callers that OMIT it (tidy/tile) must leave the
 * current selection untouched, so it must NOT be written as `selectedId: undefined` (Zustand's
 * shallow merge would clobber the selection). add/remove/duplicate pass it (string | null).
 *
 * NOTE: the gesture-driven path (`beginChange` + `updateBoard`/`resizeBoard`) and the
 * untracked paths (`tileBoards(record:false)`, `growBoardHeight`, `setViewport`, `undo`/
 * `redo`) deliberately do NOT route through here — see their own comments.
 */
function trackedChange(
  s: CanvasState,
  next: { boards?: Board[]; connectors?: Connector[]; groups?: NamedGroup[] } | null,
  opts: {
    selection?: { selectedId: string | null; selectedIds: string[] }
    reflectPresent: boolean
  }
): Partial<CanvasState> | CanvasState {
  if (next == null) return s
  const nextBoards = next.boards ?? s.boards
  const nextConnectors = next.connectors ?? s.connectors
  const nextGroups = next.groups ?? s.groups
  // No-op when nothing actually changed (same refs) — push nothing, leave undo
  // untouched (the `next === s.boards` guard, generalized to the snapshot).
  if (nextBoards === s.boards && nextConnectors === s.connectors && nextGroups === s.groups)
    return s
  if (opts.reflectPresent) {
    lastRecorded = { boards: nextBoards, connectors: nextConnectors, groups: nextGroups }
  }
  const base: Partial<CanvasState> = {
    // Push the PRE-change present (boards + connectors + groups) as one checkpoint.
    past: recordPast(s.past, { boards: s.boards, connectors: s.connectors, groups: s.groups }),
    future: [],
    boards: nextBoards,
    connectors: nextConnectors,
    groups: nextGroups
  }
  return opts.selection ? { ...base, ...opts.selection } : base
}

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
 *
 * SCENE/SESSION CONTRACT: never add an ephemeral key here (selected tool/element,
 * in-flight draft/erase, hover). Those stay in component/Zustand session state and
 * are never serialized — see boardSchema.toObject.
 */
const COMMON_KEYS = ['x', 'y', 'w', 'h', 'title', 'z'] as const
const PATCHABLE_KEYS: Record<BoardType, readonly string[]> = {
  terminal: [...COMMON_KEYS, 'shell', 'launchCommand', 'cwd', 'port'],
  browser: [...COMMON_KEYS, 'url', 'viewport', 'previewSourceId'],
  planning: [...COMMON_KEYS, 'elements']
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  boards: [],
  connectors: [],
  groups: [],
  selectedId: null,
  selectedIds: [],
  tool: 'select',
  past: [],
  future: [],
  viewport: null,
  project: { dir: null, name: null, status: 'welcome' },

  addBoard: (type, at, opts) => {
    const id = opts?.id ?? newId()
    const size = opts?.size ?? DEFAULT_BOARD_SIZE[type]
    // exact:true honours a deliberately-drawn rectangle (drag-create) verbatim; otherwise
    // nudge off any overlap (click-spawn / the MCP spawn path).
    const pos = opts?.exact ? at : freeSlot(get().boards, at, size)
    const board = createBoard(type, { id, x: pos.x, y: pos.y, w: size.w, h: size.h })
    // A fresh, this-session add is NOT idle-on-mount, so a Terminal board auto-spawns
    // on mount. Only restored/duplicated boards are flagged idle (M-1).
    set((s) =>
      trackedChange(
        s,
        { boards: [...s.boards, board] },
        { selection: { selectedId: id, selectedIds: [id] }, reflectPresent: false }
      )
    )
    return id
  },

  removeBoard: (id) =>
    set((s) => {
      // No such board → true no-op (don't record a dead undo step). `filter` alone would
      // yield a fresh array even on a miss, so trackedChange's `next === s.boards` guard can't
      // catch it — guard explicitly here, mirroring duplicateBoard's unknown-id early return.
      if (!s.boards.some((b) => b.id === id)) return s
      const next = s.boards
        .filter((b) => b.id !== id)
        // Clear a preview link whose source terminal was just removed (Slice C′).
        .map((b) =>
          b.type === 'browser' && b.previewSourceId === id
            ? { ...b, previewSourceId: undefined }
            : b
        )
      // Drop connectors incident to the removed board IN THE SAME tracked step (M2), so
      // one undo restores both the board and its cables. Only mint a new connectors array
      // when something is actually dropped (else keep the ref so trackedChange can no-op).
      const incident = s.connectors.some((c) => c.sourceId === id || c.targetId === id)
      const nextConnectors = incident
        ? s.connectors.filter((c) => c.sourceId !== id && c.targetId !== id)
        : s.connectors
      // Sweep the deleted board from all group memberships in the SAME step (mirrors the
      // connector sweep above), so one undo restores board + cables + memberships together.
      // Only mints a new groups array when a membership actually changes — keep ref for no-op.
      const inGroups = s.groups.some((g) => g.boardIds.includes(id))
      const nextGroups = inGroups
        ? s.groups.map((g) =>
            g.boardIds.includes(id) ? { ...g, boardIds: g.boardIds.filter((b) => b !== id) } : g
          )
        : s.groups
      const nextSelIds = s.selectedIds.filter((x) => x !== id)
      return trackedChange(
        s,
        { boards: next, connectors: nextConnectors, groups: nextGroups },
        {
          selection: {
            selectedIds: nextSelIds,
            selectedId: nextSelIds[nextSelIds.length - 1] ?? null
          },
          reflectPresent: false
        }
      )
    }),

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
    // Decision E: a duplicate inherits NO orchestration connectors (an orchestration
    // cable is a relationship between two specific boards). previewSourceId is still
    // copied by structuredClone above, so a duplicated linked Browser keeps its preview.
    set((s) =>
      trackedChange(
        s,
        { boards: [...s.boards, clone] },
        { selection: { selectedId: cloneId, selectedIds: [cloneId] }, reflectPresent: false }
      )
    )
    return cloneId
  },

  addConnector: (sourceId, targetId, kind) => {
    const s = get()
    // Reject a self-link, a missing endpoint, or an exact duplicate (same s+t+kind).
    if (sourceId === targetId) return null
    const ids = new Set(s.boards.map((b) => b.id))
    if (!ids.has(sourceId) || !ids.has(targetId)) return null
    if (
      s.connectors.some(
        (c) => c.sourceId === sourceId && c.targetId === targetId && c.kind === kind
      )
    ) {
      return null
    }
    const id = newId()
    const connector: Connector = { id, sourceId, targetId, kind }
    // One tracked step; leaves `boards` untouched (omit selectedId → keep selection).
    // reflectPresent:false matches add/remove/duplicate — keeps the cable granularly
    // undoable; its post-no-op phantom is the same tolerated edge (#BUG M3).
    set((st) =>
      trackedChange(st, { connectors: [...st.connectors, connector] }, { reflectPresent: false })
    )
    return id
  },

  removeConnector: (id) =>
    set((s) => {
      if (!s.connectors.some((c) => c.id === id)) return s // unknown id → no dead step
      return trackedChange(
        s,
        { connectors: s.connectors.filter((c) => c.id !== id) },
        {
          reflectPresent: false
        }
      )
    }),

  addGroup: (name, boardIds) => {
    const id = newId()
    const group: NamedGroup = { id, name, boardIds: [...new Set(boardIds)] }
    set((s) => trackedChange(s, { groups: [...s.groups, group] }, { reflectPresent: false }))
    return id
  },
  removeGroup: (id) =>
    set((s) => {
      if (!s.groups.some((g) => g.id === id)) return s
      return trackedChange(
        s,
        { groups: s.groups.filter((g) => g.id !== id) },
        { reflectPresent: false }
      )
    }),
  renameGroup: (id, name) =>
    set((s) => {
      const g = s.groups.find((x) => x.id === id)
      if (!g || g.name === name) return s
      return trackedChange(
        s,
        { groups: s.groups.map((x) => (x.id === id ? { ...x, name } : x)) },
        { reflectPresent: false }
      )
    }),
  addBoardsToGroup: (id, boardIds) =>
    set((s) => {
      const g = s.groups.find((x) => x.id === id)
      if (!g) return s
      const merged = [...new Set([...g.boardIds, ...boardIds])]
      if (merged.length === g.boardIds.length) return s
      return trackedChange(
        s,
        { groups: s.groups.map((x) => (x.id === id ? { ...x, boardIds: merged } : x)) },
        { reflectPresent: false }
      )
    }),
  removeBoardFromGroup: (id, boardId) =>
    set((s) => {
      const g = s.groups.find((x) => x.id === id)
      if (!g || !g.boardIds.includes(boardId)) return s
      return trackedChange(
        s,
        {
          groups: s.groups.map((x) =>
            x.id === id ? { ...x, boardIds: x.boardIds.filter((b) => b !== boardId) } : x
          )
        },
        { reflectPresent: false }
      )
    }),

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
      // One tracked step for the whole re-pack. trackedChange no-ops when nothing moved
      // (already tidy → no phantom step, redo branch kept). reflectPresent syncs lastRecorded
      // so a following zero-movement gesture doesn't push a phantom snapshot (#BUG M3) — at
      // the accepted cost that an immediate nudge coalesces into this tidy step.
      return trackedChange(s, changed ? { boards } : null, { reflectPresent: true })
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
      // Deliberately do NOT update `lastRecorded` here (and do NOT route through
      // trackedChange, which would). It must keep meaning "the boards the undo stack
      // reflects" — and the stack reflects the PRE-tile snapshot, not this reflow.
      // Setting it to `boards` would make the next beginChange think the reflowed layout is
      // already in history and SKIP the pre-drag checkpoint, so a real drag after a reflow
      // couldn't be undone granularly (undo would jump past it to pre-tile). The only cost of
      // leaving it stale is a phantom no-op step on a ZERO-movement titlebar press after a
      // reflow — the same tolerated edge as addBoard/removeBoard (Bug #7 / #BUG M3). A real
      // drag stays correctly undoable. Do not "fix" by syncing lastRecorded.
      if (!record) return { boards }
      // Tracked apply: one undo step + lastRecorded sync via trackedChange (reflectPresent).
      return trackedChange(s, { boards }, { reflectPresent: true })
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

  selectBoard: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
  toggleSelect: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id)
      const selectedIds = has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
      return { selectedIds, selectedId: selectedIds[selectedIds.length - 1] ?? null }
    }),
  setSelection: (ids) => {
    const selectedIds = [...new Set(ids)]
    set({ selectedIds, selectedId: selectedIds[selectedIds.length - 1] ?? null })
  },
  setTool: (tool) => set({ tool }),
  beginChange: () =>
    set((s) => {
      // No change since the last checkpoint → skip, so a no-op gesture doesn't push a
      // duplicate snapshot. Two cases of "unchanged": the present matches the past tail
      // (normal post-edit), OR it matches `lastRecorded` — the present left by an
      // undo/redo. The past-tail check alone MISSES the post-undo case (#BUG M3): undo
      // pops the tail, so the present (the popped value) ≠ the new past tail even though
      // it's unchanged → a no-op beginChange would push a phantom snapshot. Compared by
      // BOTH boards and connectors refs (a connector-only edit changes connectors only).
      if (sameSnapshot(s.past[s.past.length - 1], s) || sameSnapshot(lastRecorded, s)) return s
      // Take the pre-edit snapshot but do NOT clear the redo branch here (Bug #7).
      // beginChange fires at GESTURE START, before we know whether the gesture will
      // commit anything — a zero-movement titlebar/resize-handle click or a degenerate
      // arrow/pen tap calls it but mutates nothing. The redo branch is correctly
      // invalidated by the actual mutation: updateBoard/resizeBoard clear `future` only
      // when boards truly change.
      const snap: CanvasSnapshot = { boards: s.boards, connectors: s.connectors, groups: s.groups }
      lastRecorded = snap
      return { past: recordPast(s.past, snap) }
    }),
  undo: () =>
    set((s) => {
      const r = applyUndo(
        s.past,
        { boards: s.boards, connectors: s.connectors, groups: s.groups },
        s.future
      )
      if (!r) return s
      // The present after undo IS the history-reflected state — record it so a following
      // no-op beginChange recognizes it and doesn't push a phantom snapshot (#BUG M3).
      lastRecorded = r.present
      return {
        boards: r.present.boards,
        connectors: r.present.connectors,
        groups: r.present.groups,
        past: r.past,
        future: r.future,
        selectedId: null,
        selectedIds: []
      }
    }),
  redo: () =>
    set((s) => {
      const r = applyRedo(
        s.past,
        { boards: s.boards, connectors: s.connectors, groups: s.groups },
        s.future
      )
      if (!r) return s
      lastRecorded = r.present
      return {
        boards: r.present.boards,
        connectors: r.present.connectors,
        groups: r.present.groups,
        past: r.past,
        future: r.future,
        selectedId: null,
        selectedIds: []
      }
    }),

  // Re-derive preview connectors from board state (previewSourceId = runtime SoT) and
  // concat the in-memory orchestration connectors → the full persisted set (Decision B).
  toObject: () =>
    toObject(
      get().boards,
      get().viewport,
      [...previewConnectorsFor(get().boards), ...get().connectors],
      get().groups
    ),
  loadObject: (doc) => {
    // Guard the deep-validation throw (corrupt board/element or too-new schemaVersion):
    // a raw-doc load with no dir can't do a .bak retry, so on a throw set status:'error'
    // (with the message) and leave board/connector/viewport state UNTOUCHED — do NOT null
    // lastRecorded or flag restored terminals until the parse actually succeeds. Matches
    // applyOpenResult's guard so a corrupt doc never throws out and blanks the app (T4).
    let d: ReturnType<typeof fromObject>
    try {
      d = fromObject(doc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to load project'
      set((s) => ({ project: { ...s.project, status: 'error', error: msg } }))
      return
    }
    // Clear the dedup ref: it points at the pre-load snapshot; a fresh project's history
    // starts empty, so a dangling ref must not survive the load (#BUG M3 hygiene).
    lastRecorded = null
    // Disk-restored terminals must start IDLE (no auto-spawn / no launchCommand on
    // reopen) — flag every loaded terminal idle-on-mount (M-1).
    markRestoredIdle(d.boards)
    set({
      boards: d.boards,
      connectors: d.connectors,
      groups: d.groups ?? [],
      viewport: d.viewport,
      selectedId: null,
      selectedIds: [],
      past: [],
      future: []
    })
  },
  setProjectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
  applyOpenResult: async (r) => {
    if (!r.ok) {
      set((s) => ({ project: { ...s.project, status: 'error', error: r.error } }))
      return
    }
    // Guard the deep-validation throw: MAIN validated only the envelope, so an
    // envelope-valid but deep-corrupt doc (or one with a too-new schemaVersion) throws
    // out of fromObject here. Route it to status:'error' (carrying the message) and leave
    // board state untouched, instead of letting the throw blank the app (T4).
    let d: ReturnType<typeof fromObject>
    try {
      d = fromObject(r.doc)
    } catch (err) {
      // T5: the primary was envelope-valid (so MAIN's parse/envelope .bak fallback never
      // fired) but deep-corrupt. Retry the project's canvas.json.bak — if it loads, recover
      // to 'open'; if it ALSO throws (or there is no readable .bak), fall through to 'error'
      // carrying the ORIGINAL primary-parse message.
      const bak = await window.api.project.reopenFromBak(r.dir)
      if (bak.ok) {
        try {
          const d2 = fromObject(bak.doc)
          lastRecorded = null
          markRestoredIdle(d2.boards)
          set({
            boards: d2.boards,
            connectors: d2.connectors,
            groups: d2.groups ?? [],
            viewport: d2.viewport,
            selectedId: null,
            selectedIds: [],
            past: [],
            future: [],
            project: { dir: r.dir, name: r.name, status: 'open' }
          })
          return
        } catch (bakErr) {
          // .bak is also deep-corrupt → fall through to the error path below (carrying the
          // ORIGINAL primary message). Warn so the lost last-good snapshot leaves a trace,
          // matching the repo's recovery-failure logging (llmBudget/llmKeyStore).
          // eslint-disable-next-line no-console
          console.warn('[canvasStore] canvas.json.bak recovery also failed to parse', bakErr)
        }
      }
      const msg = err instanceof Error ? err.message : 'failed to load project'
      set((s) => ({ project: { ...s.project, status: 'error', error: msg } }))
      return
    }
    // Clear the dedup ref (see loadObject): the opened project's history starts empty.
    lastRecorded = null
    // Restored terminals start idle — flag every loaded terminal idle-on-mount (M-1).
    markRestoredIdle(d.boards)
    set({
      boards: d.boards,
      connectors: d.connectors,
      groups: d.groups ?? [],
      viewport: d.viewport,
      selectedId: null,
      selectedIds: [],
      past: [],
      future: [],
      project: { dir: r.dir, name: r.name, status: 'open' }
    })
  }
}))

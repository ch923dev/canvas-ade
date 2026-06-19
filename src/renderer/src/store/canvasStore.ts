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
  type CanvasBackground,
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
  DEFAULT_BOARD_SIZE,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_BACKGROUND_SATURATION,
  SCHEMA_VERSION
} from '../lib/boardSchema'
import { showToast } from './toastStore'
import { recordPast, applyUndo, applyRedo } from './history'
import { nextViewport } from '../lib/viewportCycle'
import { tidyLayout, type TidyMode } from '../lib/tidyLayout'
import { tileLayout, type TileTemplate } from '../lib/tileLayout'
import { freeSlot, PLACE_GAP } from '../lib/freeSlot'
import { useCommandStore, commandStoreDefaults } from './commandStore'
import { createConnectorSlice } from './slices/connectorSlice'
import { createFileBoardSlice } from './slices/fileBoardSlice'
import { createGroupSlice, pruneBoardFromGroups } from './slices/groupSlice'
import type { SetCanvasState } from './slices/sliceTypes'

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
   * Full multi-selection set. Populated by React Flow's native node selection (Shift+drag
   * marquee, Ctrl/⌘-click to add — RF's default selection/multi-selection key codes), folded
   * in `Canvas.onNodesChange` via `foldSelectionIntents` and written with `setSelection`.
   * `selectedId` is the PRIMARY — the last id added — kept in sync as
   * `selectedIds[selectedIds.length - 1] ?? null` so single-select consumers (preview
   * liveness, full view) are unchanged. Ephemeral: never serialized (scene/session split),
   * reset to [] on load/undo like selectedId.
   */
  selectedIds: string[]
  tool: Tool
  /** Undo/redo rails (internal — drive via beginChange/undo/redo, don't read directly). */
  past: CanvasSnapshot[]
  future: CanvasSnapshot[]
  /** Persisted camera transform (null = not yet captured / fit on load). */
  viewport: CanvasViewport | null
  /**
   * Canvas backdrop (schema v9). SETTINGS-CLASS like `viewport`: persisted in the doc,
   * NEVER on the undo rail (a wallpaper change must not eat a Ctrl+Z). `null` = the
   * feature is untouched — today's flat void, omitted from the serialized doc.
   */
  background: CanvasBackground | null
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
   * Id of a terminal awaiting first-run config in the New Terminal dialog (place-first
   * flow). EPHEMERAL session state — never serialized (scene/session split): set by a
   * user-placed terminal (`addBoard` with `opts.configPending`), cleared on Create/Cancel
   * (`clearConfigPending`) or if the board is removed. While set, the matching terminal's
   * spawn effect is gated OFF so the PTY does not auto-spawn until the dialog resolves.
   * The MCP `spawn_board` path never sets it (agents configure via `configure_board`).
   */
  configPendingId: string | null
  /**
   * One-shot "camera-focus this board next" request — EPHEMERAL (never serialized; optional so it
   * needs no initializer). `openFileBoard` sets it to the opened board's id on the tree-click path;
   * a Canvas effect consumes it (focusBoardById + dim) then clears it. Decouples the store from the
   * React Flow instance so opening a file from the tree always pans the camera onto it.
   */
  pendingFocusId?: string | null
  /**
   * Add a board of `type` at a world position; selects it; returns its id. `opts.id`
   * injects a caller-minted id (the MCP `spawn_board` path mints the id in MAIN so
   * the tool can return it to the agent); omitted → the store mints one. `opts.configPending`
   * (terminal only) holds the board's spawn until the New Terminal dialog resolves.
   */
  addBoard: (
    type: BoardType,
    at: { x: number; y: number },
    opts?: {
      id?: string
      size?: { w: number; h: number }
      exact?: boolean
      configPending?: boolean
      /** File board only (v12): bind the new board to this relative path. */
      path?: string
    }
  ) => string
  /**
   * Spawn a feature-zone CLUSTER in ONE undoable step (PR-5b, the MCP `spawnGroup` write path):
   * the boards (terminal always; planning/browser per `members`) laid out as a row near `at`, a
   * Named Group over them, and — when a browser member is present — its `previewSourceId` folded
   * onto the terminal (the runtime source of truth the preview edge derives from). MAIN mints
   * every id; the renderer owns placement. Returns the group id.
   */
  spawnGroup: (spec: {
    at: { x: number; y: number }
    group: { id: string; name: string }
    members: {
      // Phase C: an optional agentic-CLI launchCommand (MAIN-sanitized) the terminal boots, so a
      // dispatched prompt reaches an agent, not a bare shell.
      terminal: { id: string; launchCommand?: string }
      planning?: { id: string }
      browser?: { id: string }
    }
  }) => { groupId: string }
  /** Clear the New Terminal config-pending flag (dialog Create/Cancel), releasing the spawn. */
  clearConfigPending: () => void
  /**
   * Open a File board bound to `relPath` (file-tree epic, the S1 contract the tree-row click +
   * the file-ref chip click both call). If a File board for that EXACT path is already open,
   * SELECTS it instead of duplicating; otherwise creates a fresh `'file'` board (one undo step,
   * freeSlot-placed). Returns the board id (the existing one when re-focusing).
   *
   * `at` is the world-space TOP-LEFT to place a new board (a canvas drop passes the cursor
   * position); omit it for the tree-click path → the board lands near the viewport centre AND a
   * camera focus is requested (`pendingFocusId`). A drop already lands under the cursor, so it
   * does NOT yank the camera.
   */
  openFileBoard: (relPath: string, at?: { x: number; y: number }) => string
  /**
   * Open MANY files at once as PINNED boards in a tidy grid centred on the viewport (skips files
   * already open → just (re)selects them); selects the resulting set. The tree's multi-select →
   * "Open N boards" path — the canvas-native answer to VS Code's split-editor grid.
   */
  openFileBoards: (relPaths: string[]) => void
  /**
   * EPHEMERAL — the id of the single "peek" (preview) File board, or null. A board is a PEEK board
   * ⟺ its id === `peekBoardId`: FileBoard renders it ghosted, the tree rebinds it on each
   * single-click, and it is recycled so browsing never litters the canvas (VS Code preview-tab
   * discipline). Pinning clears it. Never serialized. See `slices/fileBoardSlice.ts`.
   */
  peekBoardId: string | null
  /** Tree SINGLE-click: open `relPath` in the ONE reusable peek board (rebinds/spawns it), or
   *  focus a board already showing that path. */
  peekFile: (relPath: string) => void
  /** Promote a peek board to a permanent (pinned) board (clears `peekBoardId` iff it matches). */
  pinBoard: (id: string) => void
  /** Tree DOUBLE-click: open `relPath` as a PINNED board (promotes the peek, or focuses/spawns). */
  pinFile: (relPath: string) => void
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
  /** Add boards to a group AND move every member to `placements` in one tracked step (the
   *  "absorb" reflow). No-op when membership and positions are both unchanged. */
  addBoardsToGroupReflowed: (
    id: string,
    boardIds: string[],
    placements: { id: string; x: number; y: number }[]
  ) => void
  /** Remove one board from a group. One tracked step; no-op if not a member. */
  removeBoardFromGroup: (id: string, boardId: string) => void
  /** Remove a board from EVERY group it belongs to in ONE tracked step (mirrors removeBoard's
   *  membership sweep). One undo restores all memberships. No-op if it's in no group. */
  removeBoardFromAllGroups: (boardId: string) => void
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
  /**
   * Write a diagram element's DERIVED svgCache (v11/S4). UNTRACKED — the SVG is a render
   * artifact of the canonical `source`, not a user edit, so the async write-back from the hidden
   * worker must NEVER push an undo step nor wipe an armed redo branch (the `lastRecorded`/
   * growBoardHeight rule). No-op when the element is gone, not a diagram, or the cache is unchanged.
   */
  setDiagramCache: (boardId: string, elId: string, svgCache: string) => void
  /** Set the camera transform. UNTRACKED — never touches undo/redo (like growBoardHeight). */
  setViewport: (vp: CanvasViewport) => void
  /**
   * Merge a partial backdrop change over the current value (or the defaults when unset).
   * UNTRACKED — settings-class, like setViewport. Live slider drags ride the debounced
   * autosave; no dedicated save path.
   */
  setBackground: (patch: Partial<CanvasBackground>) => void
  selectBoard: (id: string | null) => void
  /** Replace the whole multi-selection (RF marquee/multi-click fold). Primary = last id, or
   *  null when empty. The single source for writing `selectedIds` (no per-id toggle action —
   *  React Flow owns the add/remove gesture; `Canvas.onNodesChange` folds it to a full set). */
  setSelection: (ids: string[]) => void
  setTool: (tool: Tool) => void
  /** Capture the pre-edit snapshot for undo (call at the start of a discrete edit). The
   *  checkpoint is recorded LAZILY — pushed onto `past` by the gesture's first real
   *  mutation (updateBoard/resizeBoard), so a mutation-free gesture records nothing. */
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
 * Lazy gesture checkpoint (#BUG-004). `beginChange()` CAPTURES the pre-gesture snapshot
 * here instead of eagerly pushing it onto `past`; the FIRST real mutation of the gesture
 * (updateBoard/resizeBoard) consumes it via `takePendingPast`. A mutation-free gesture
 * (zero-movement titlebar click, degenerate pen/arrow tap) therefore records nothing —
 * the phantom-step class (#BUG M3 / Bug #7) is closed structurally, with no skip token
 * that can go stale. The previous eager model reused `lastRecorded` (the snapshot the
 * rails "already reflect") as that skip token, and undo()/redo() pointed it at the
 * snapshot just POPPED off a rail — so the first real edit after an undo SKIPPED its
 * checkpoint, the following mutation cleared `future`, and the undone-to state became
 * unreachable from BOTH rails (#BUG-004: addBoard → move → undo → move → undo left an
 * empty canvas). Invalidated (nulled) by trackedChange, undo/redo, and every load path —
 * once the present moves on, the captured snapshot is stale.
 */
let pendingCheckpoint: CanvasSnapshot | null = null

/**
 * Consume the pending gesture checkpoint: returns `past` with it appended (the lazy
 * record), or `past` unchanged when no gesture is pending. Call ONLY on a real mutation
 * — a no-op patch must leave the pending snapshot armed for the gesture's first real edit.
 */
function takePendingPast(s: CanvasState): CanvasSnapshot[] {
  const snap = pendingCheckpoint
  pendingCheckpoint = null
  return snap ? recordPast(s.past, snap) : s.past
}

/**
 * Apply a self-contained canvas mutation as ONE tracked undo step. `next` is the
 * already-computed next snapshot object `{ boards?, connectors?, groups? }`, or null to
 * signal "no change" (push nothing, leave undo/redo untouched). Centralizes the
 * `recordPast` + future-clear the tracked actions each hand-rolled. Pure: takes state,
 * returns a partial — side values (a new id) are computed by the caller.
 *
 * `opts.reflectPresent` is RETAINED for call-site compatibility (the connector/group slices
 * pass it) but is now INERT: it existed to sync the eager model's `lastRecorded` skip token
 * so a no-op gesture after tidy/tile wouldn't push a phantom snapshot. Under the lazy
 * checkpoint model (#BUG-004, see `pendingCheckpoint`) beginChange never pushes, so there is
 * no phantom to suppress — and a real move right after tidy now gets its own granular
 * checkpoint instead of coalescing into the tidy step.
 *
 * Returns a `Partial<CanvasState>` patch on a real change, or the full `s` (a same-ref no-op
 * merge) when `next` is null / unchanged — hence the `| CanvasState` in the return type.
 * Callers that OMIT `opts.selection` (tidy/tile, connector ops, group ops) leave the current
 * selection untouched — do NOT write `selectedId: undefined` (Zustand's shallow merge would
 * clobber it); add/remove/duplicate pass a full `{ selectedId, selectedIds }`.
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
  // A tracked op moves the present on — any un-consumed gesture checkpoint is now stale
  // (pushing it later would duplicate the snapshot this op records below).
  pendingCheckpoint = null
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
 * terminals are idle". Module-scoped (mirrors `pendingCheckpoint`); never persisted.
 */
const idleOnMountIds = new Set<string>()

/**
 * Idle flags swept off the live registry, PARKED so a later history jump that resurrects
 * the board restores them (#BUG-012: duplicate -> undo -> redo must keep the clone idle —
 * without the symmetric re-add the redone clone auto-spawned its shell + launchCommand,
 * violating M-1). An id lands here two ways: (a) undo drops a board from the present (it
 * can only ever return via a `future` snapshot — redo); (b) a DIRECT `removeBoard` of an
 * idle terminal (it can only ever return via a `past` snapshot — undo). So a parked id is
 * dead only once it is unreachable from EVERY rail (present u past u future), which is the
 * GC condition below — broadened from the old future-only prune that leaked a directly
 * deleted-then-evicted terminal's id (BUG-012).
 */
const parkedIdleIds = new Set<string>()

/**
 * GC parked idle flags against the WHOLE history graph (BUG-012/BUG-033): a parked id is
 * dropped only when no present/past/future snapshot can ever resurrect its board — so a
 * directly removed terminal's flag is reclaimed once its last `past` snapshot is evicted
 * by the 50-entry history cap (the leak BUG-012 was filed for), while a flag still
 * reachable on any rail (awaiting an undo or a redo) is kept. Call AFTER the rails settle.
 */
function gcParkedIdle(present: Board[], past: CanvasSnapshot[], future: CanvasSnapshot[]): void {
  if (parkedIdleIds.size === 0) return
  const reachable = new Set<string>()
  for (const b of present) reachable.add(b.id)
  for (const snap of past) for (const b of snap.boards) reachable.add(b.id)
  for (const snap of future) for (const b of snap.boards) reachable.add(b.id)
  for (const id of [...parkedIdleIds]) if (!reachable.has(id)) parkedIdleIds.delete(id)
}

/** Whether `id` must mount idle (restored/duplicated, not yet started). Non-consuming. */
export function isIdleOnMount(id: string): boolean {
  return idleOnMountIds.has(id)
}

/** Drop the idle flag — called when the user explicitly Starts a restored terminal, so a
 *  subsequent in-session respawn / remount of that board spawns normally. */
export function clearIdleOnMount(id: string): void {
  idleOnMountIds.delete(id)
}

/**
 * Test-only: the combined size of the live + parked idle-flag registries — the exact
 * session-lifetime leak surface BUG-012/BUG-033 guard. Exposed so a regression test can
 * assert a directly removed terminal's UUID is reclaimed (not stranded) once the history
 * rail evicts its last snapshot. Not used in app code.
 */
export function idleFlagRegistrySize(): number {
  return idleOnMountIds.size + parkedIdleIds.size
}

/** Mark every terminal in a freshly-loaded doc as idle-on-mount (restore path). */
function markRestoredIdle(boards: Board[]): void {
  idleOnMountIds.clear()
  parkedIdleIds.clear() // a fresh load empties the redo rail — nothing parked can return
  for (const b of boards) if (b.type === 'terminal') idleOnMountIds.add(b.id)
}

/**
 * Commit a freshly-parsed, migrated document into the store: clears any pending gesture
 * checkpoint (a loaded project's history starts empty), flags restored terminals
 * idle-on-mount, and resets boards/connectors/groups/viewport/selection/history. Pass
 * `project` to also mark the project open (the applyOpenResult paths); omit it for a raw
 * loadObject. The `pendingCheckpoint = null` + `markRestoredIdle` side effects live HERE
 * so no load path (loadObject / open / .bak recovery) can forget either (#BUG M3 hygiene
 * + M-1 idle rule).
 */
function applyLoadedDoc(
  set: SetCanvasState,
  d: ReturnType<typeof fromObject>,
  project?: ProjectState
): void {
  pendingCheckpoint = null
  markRestoredIdle(d.boards)
  set({
    boards: d.boards,
    connectors: d.connectors,
    groups: d.groups ?? [],
    viewport: d.viewport,
    background: d.background ?? null,
    selectedId: null,
    selectedIds: [],
    past: [],
    future: [],
    // A load/switch starts fresh — drop any ephemeral pending-config flag from the prior project.
    configPendingId: null,
    ...(project ? { project } : {})
  })
  // The Command board's queue/view/collapse is GLOBAL ephemeral state (one orchestrator face) —
  // reset it on a project load so the prior project's collapsed/groups view can't render the new
  // project's command board wrong (the same fresh-start intent as configPendingId above).
  useCommandStore.setState(commandStoreDefaults())
}

/**
 * #BUG-013: monotonic open generation. Each applyOpenResult entry bumps it; the awaited
 * `.bak`-retry continuation re-checks after its await and DISCARDS its late result when a
 * newer open has superseded it — otherwise a slow .bak recovery (or its error-set) would
 * clobber a concurrently opened project with the stale project's content.
 */
let openEpoch = 0

/**
 * #BUG-009: cross-surface in-flight project-switch lock. WelcomeScreen's per-mount `busy`
 * state cannot see a switch started from the ProjectSwitcher — switching flips status to
 * 'loading', which unmounts Canvas and mounts a FRESH WelcomeScreen (busy=false), so two
 * open pipelines could interleave; MAIN's currentDir then points at the LAST-STARTED open
 * while the renderer keeps whichever applyOpenResult settled LAST, and the next autosave
 * cross-writes one project's canvas into the other's canvas.json. Module-scoped so every
 * open/create/switch surface shares ONE lock. acquire → false means another switch is in
 * flight: bail without touching project state.
 */
let projectSwitchInFlight = false
export function acquireProjectSwitchLock(): boolean {
  if (projectSwitchInFlight) return false
  projectSwitchInFlight = true
  return true
}
export function releaseProjectSwitchLock(): void {
  projectSwitchInFlight = false
}

// Board auto-placement (freeSlot) + the shared PLACE_GAP margin now live in lib/freeSlot.ts
// (file-size doctrine — pure geometry → lib). addBoard/spawnGroup import them above.

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
  // `agentSessionId`/`agentTranscriptPath` are terminal-only app-learned fields the
  // recap hook (`recap:learned`) patches onto a board so its recap survives reload —
  // they round-trip through toObject like any other terminal prop, so they belong here.
  terminal: [
    ...COMMON_KEYS,
    'shell',
    'launchCommand',
    'cwd',
    'port',
    'agentSessionId',
    'agentTranscriptPath',
    'fontSize',
    // v10 (New Terminal presets): the chosen agent identity + whether the board joins
    // activity monitoring (MCP attention/swarm). Both terminal-scoped + serialized.
    'agentKind',
    'monitorActivity'
  ],
  browser: [...COMMON_KEYS, 'url', 'viewport', 'previewSourceId'],
  planning: [...COMMON_KEYS, 'elements'],
  // The Command board persists no per-type fields (its task queue is ephemeral commandStore
  // state) — only the common geometry/title keys are patchable (e.g. the collapse height swap).
  command: [...COMMON_KEYS],
  // v13 file board (file-tree S1): bound relative path + read-only flag; content never persisted.
  file: [...COMMON_KEYS, 'path', 'readOnly']
}

/**
 * Apply a type-filtered shallow patch to one board. Returns the new boards array, or
 * null when nothing actually changed (unknown id, only off-type keys, or identical
 * values) so callers can no-op without minting a new ref. Shared by `updateBoard`
 * (tracked-edit semantics) and `patchBoardUntracked` (history-neutral machine writes).
 */
function applyBoardPatch(boards: Board[], id: string, patch: Partial<Board>): Board[] | null {
  const src = patch as Record<string, unknown>
  let changed = false
  const next = boards.map((b) => {
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
  return changed ? next : null
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
  background: null,
  configPendingId: null,
  project: { dir: null, name: null, status: 'welcome' },

  addBoard: (type, at, opts) => {
    // Singleton orchestrator (Phase A): the Command board is the single face of the MCP
    // orchestrator (one 'app' token, one ephemeral commandStore). Never mint a second — select and
    // return the existing one. Covers the dock/palette/empty-state add paths (all route through
    // addBoard); duplicateBoard guards the singleton separately (it does NOT route through here).
    if (type === 'command') {
      const existing = get().boards.find((b) => b.type === 'command')
      if (existing) {
        get().setSelection([existing.id])
        return existing.id
      }
      // Minting a brand-new orchestrator: clear any ephemeral commandStore state a prior
      // (since-deleted) command board left behind, so its collapse/view doesn't bleed onto the
      // fresh board. applyLoadedDoc resets this on project load; this covers delete-then-re-add
      // within a session. (Undo-restore goes through history, not addBoard, so it's unaffected —
      // a restored board keeps the view it had at delete time.)
      useCommandStore.setState(commandStoreDefaults())
    }
    const id = opts?.id ?? newId()
    const size = opts?.size ?? DEFAULT_BOARD_SIZE[type]
    // exact:true honours a deliberately-drawn rectangle (drag-create) verbatim; otherwise
    // nudge off any overlap (click-spawn / the MCP spawn path).
    const pos = opts?.exact ? at : freeSlot(get().boards, at, size)
    const board = createBoard(type, {
      id,
      x: pos.x,
      y: pos.y,
      w: size.w,
      h: size.h,
      // File board only: bind the relative path (createBoard ignores it for other types).
      ...(opts?.path ? { path: opts.path } : {})
    })
    // A fresh, this-session add is NOT idle-on-mount, so a Terminal board auto-spawns
    // on mount. Only restored/duplicated boards are flagged idle (M-1).
    // Place-first New Terminal flow: a user-placed terminal holds its spawn until the
    // dialog resolves (the spawn effect is gated on configPendingId). Terminal-only +
    // never on the MCP path. EPHEMERAL — set OUTSIDE trackedChange so it isn't snapshotted
    // onto the undo rail.
    const pending = opts?.configPending === true && type === 'terminal'
    set((s) =>
      trackedChange(
        s,
        { boards: [...s.boards, board] },
        { selection: { selectedId: id, selectedIds: [id] }, reflectPresent: false }
      )
    )
    if (pending) set({ configPendingId: id })
    return id
  },

  spawnGroup: (spec) => {
    const { at, group, members } = spec
    // Build the ordered member list (terminal first; planning/browser opt-in) → the row layout
    // + the group's boardIds both follow this order.
    const order: { id: string; type: BoardType }[] = [
      { id: members.terminal.id, type: 'terminal' },
      ...(members.planning ? [{ id: members.planning.id, type: 'planning' as BoardType }] : []),
      ...(members.browser ? [{ id: members.browser.id, type: 'browser' as BoardType }] : [])
    ]
    // Find ONE free slot for the whole cluster's bounding box, then tile the members left-to-right
    // inside it — so the zone lands as a contiguous, non-overlapping row (freeSlot only nudges a
    // single box, so sizing it to the full width keeps the cluster together).
    const sizes = order.map((m) => DEFAULT_BOARD_SIZE[m.type])
    const totalW = sizes.reduce((sum, s) => sum + s.w, 0) + PLACE_GAP * (sizes.length - 1)
    const maxH = Math.max(...sizes.map((s) => s.h))
    const origin = freeSlot(get().boards, at, { w: totalW, h: maxH })
    let cursorX = origin.x
    const newBoards: Board[] = order.map((m, i) => {
      const s = sizes[i]
      const board = createBoard(m.type, { id: m.id, x: cursorX, y: origin.y, w: s.w, h: s.h })
      cursorX += s.w + PLACE_GAP
      // Wire the browser member to the terminal: previewSourceId is the runtime SoT the preview
      // edge derives from (the cluster's only "connector" — orchestration cables are terminal↔
      // terminal, N/A within a single-worker zone).
      if (board.type === 'browser' && members.browser) {
        return { ...board, previewSourceId: members.terminal.id }
      }
      // Phase C: boot the terminal member's agentic CLI (the dispatched prompt then reaches an
      // agent, not a bare shell). MAIN already sanitized the launchCommand to a single PTY line.
      if (board.type === 'terminal' && typeof members.terminal.launchCommand === 'string') {
        return { ...board, launchCommand: members.terminal.launchCommand }
      }
      return board
    })
    const namedGroup: NamedGroup = {
      id: group.id,
      name: group.name,
      boardIds: order.map((m) => m.id)
    }
    // ONE tracked step covers the whole zone (boards + group + wiring) → a single undo removes it.
    // reflectPresent:false matches addBoard/addGroup (granularly undoable; the tolerated #BUG M3
    // post-no-op phantom). Select the terminal (the zone's anchor) + the whole cluster.
    set((s) =>
      trackedChange(
        s,
        { boards: [...s.boards, ...newBoards], groups: [...s.groups, namedGroup] },
        {
          selection: { selectedId: members.terminal.id, selectedIds: order.map((m) => m.id) },
          reflectPresent: false
        }
      )
    )
    return { groupId: group.id }
  },

  clearConfigPending: () => set({ configPendingId: null }),

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
      // prune returns null when the board is in no group → `?? s.groups` keeps the ref so
      // trackedChange no-ops the groups field (membership unchanged).
      const nextGroups = pruneBoardFromGroups(s.groups, id) ?? s.groups
      const nextSelIds = s.selectedIds.filter((x) => x !== id)
      const result = trackedChange(
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
      // BUG-012: a DIRECT delete of an idle terminal must not leak its UUID. Don't EAGERLY
      // delete the flag (that would resurrect a started agent on undo — the respawn class);
      // PARK it instead, so an immediate undo re-promotes it (see undo's resurrection sweep),
      // and let gcParkedIdle reclaim it once its last `past` snapshot is evicted by the
      // history cap. The pre-remove snapshot trackedChange just pushed onto `result.past`
      // still holds the board, so the parked id is reachable until then.
      if (idleOnMountIds.delete(id)) parkedIdleIds.add(id)
      // GC against the settled rails: present = `next`, future = [] (trackedChange cleared
      // it), past = result.past (the rail trackedChange just recorded — a real removal is
      // never a no-op here, so result always carries the new rails).
      const newPast = 'past' in result && result.past ? result.past : s.past
      gcParkedIdle(next, newPast, [])
      // Drop a dangling config-pending flag if the awaiting-config terminal is the one being
      // removed here (MCP close / user delete while its New Terminal dialog is open). Undo and
      // project-load prune it separately — they restore boards from a snapshot, not via
      // removeBoard.
      return s.configPendingId === id ? { ...result, configPendingId: null } : result
    }),

  duplicateBoard: (id) => {
    const src = get().boards.find((b) => b.id === id)
    if (!src) return null
    // The Command board is a singleton (one orchestrator face) — duplicating it would forge a
    // second one, and this path bypasses addBoard's guard. No-op it. (#175 reviewer.)
    if (src.type === 'command') return null
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

  ...createConnectorSlice(set, get, { trackedChange, newId }),

  ...createFileBoardSlice(set, get),

  ...createGroupSlice(set, get, { trackedChange, newId }),

  updateBoard: (id, patch) =>
    set((s) => {
      // A patch may carry props (move, rename, per-type fields) but MUST NOT change
      // a board's identity or type, nor smuggle an off-type field (e.g. a `url`
      // landing on a terminal board) — that would forge a cross-type hybrid the
      // discriminated union forbids. applyBoardPatch keeps only the keys valid for
      // the target board's type and returns null on a true no-op.
      const boards = applyBoardPatch(s.boards, id, patch)
      if (!boards) return s
      // First real mutation of the gesture: consume the pending beginChange checkpoint
      // (lazy record, #BUG-004). A live edit also invalidates any armed redo branch
      // (else redo could clobber it).
      const past = takePendingPast(s)
      return s.future.length ? { boards, past, future: [] } : { boards, past }
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
      // Consume the pending beginChange checkpoint (lazy record, #BUG-004) — see updateBoard.
      const past = takePendingPast(s)
      return s.future.length ? { boards, past, future: [] } : { boards, past }
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
      // (already tidy → no phantom step, redo branch kept). A following zero-movement
      // gesture records nothing under the lazy-checkpoint model (#BUG M3 closed), and a
      // real nudge right after gets its own granular step (no coalescing).
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
      // growBoardHeight) so a resize storm can't flood the history. Untracked paths never
      // touch the pending gesture checkpoint — a real drag after a reflow stays granularly
      // undoable (its beginChange captures the reflowed present).
      if (!record) return { boards }
      // Tracked apply: one undo step via trackedChange.
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

  setDiagramCache: (boardId, elId, svgCache) =>
    set((s) => {
      // Derived-artifact write, untracked (v11/S4): set the diagram's svgCache WITHOUT touching
      // past/future, exactly like growBoardHeight. A source edit is the tracked step; this cache
      // write that follows it (and any background re-render) must not add or coalesce an undo step.
      let changed = false
      const boards = s.boards.map((b) => {
        if (b.id !== boardId || b.type !== 'planning') return b
        const elements = b.elements.map((el) => {
          if (el.id !== elId || el.kind !== 'diagram' || el.svgCache === svgCache) return el
          changed = true
          return { ...el, svgCache }
        })
        return changed ? { ...b, elements } : b
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

  setBackground: (patch) =>
    set((s) => {
      // First touch materializes the defaults (kind none / dim 0.25 / sat 0.70 / no grid)
      // so slider state survives source toggles. Identical-value merges no-op (slider
      // drags fire continuously — don't notify subscribers for nothing, #BUG L2 class).
      const base: CanvasBackground = s.background ?? {
        kind: 'none',
        dim: DEFAULT_BACKGROUND_DIM,
        saturation: DEFAULT_BACKGROUND_SATURATION,
        gridDots: false
      }
      const src = patch as Record<string, unknown>
      const cur = base as unknown as Record<string, unknown>
      let diff = s.background === null
      for (const k in src) if (cur[k] !== src[k]) diff = true
      if (!diff) return s
      // Keep kind-specific fields only for the active kind, so a source switch never
      // serializes dead keys into canvas.json (mirrors reconcileBackground's load-time
      // pruning in boardSchema.ts — the live doc and a reloaded doc agree on shape).
      const next: CanvasBackground = { ...base, ...patch }
      if (next.kind !== 'file') delete next.assetId
      if (next.kind !== 'scene') {
        delete next.scene
        delete next.sceneVariant
      }
      return { background: next }
    }),

  selectBoard: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
  setSelection: (ids) => {
    const selectedIds = [...new Set(ids)]
    set({ selectedIds, selectedId: selectedIds[selectedIds.length - 1] ?? null })
  },
  setTool: (tool) => set({ tool }),
  beginChange: () => {
    // Lazy checkpoint (#BUG-004): CAPTURE the pre-gesture snapshot; it is pushed onto
    // `past` only when the gesture commits a real mutation (updateBoard/resizeBoard
    // consume it via takePendingPast). beginChange fires at GESTURE START, before we
    // know whether the gesture will commit anything — a zero-movement titlebar/resize-
    // handle click or a degenerate arrow/pen tap calls it but mutates nothing, and must
    // neither push a phantom undo step (#BUG M3 / Bug #7) nor clear the redo branch.
    // Because nothing is pushed eagerly, there is no post-undo skip token to go stale:
    // after an undo, the next gesture's first real edit checkpoints the undone-to
    // present like any other state (#BUG-004).
    const s = get()
    pendingCheckpoint = { boards: s.boards, connectors: s.connectors, groups: s.groups }
  },
  undo: () =>
    set((s) => {
      const r = applyUndo(
        s.past,
        { boards: s.boards, connectors: s.connectors, groups: s.groups },
        s.future
      )
      if (!r) return s
      // A history jump invalidates any un-consumed gesture checkpoint (#BUG-004) — the
      // next gesture re-captures from the restored present.
      pendingCheckpoint = null
      // BUG-033: boards that vanish from the present snapshot (e.g. a duplicated terminal
      // clone that was just undone) must be reclaimed from idleOnMountIds, or the Set
      // accumulates dead UUIDs across duplicate+undo cycles (session-lifetime memory leak).
      // BUG-012: PARK (not drop) a swept flag so a redo that resurrects the board restores
      // it — otherwise duplicate → undo → redo auto-spawned the clone's agent (M-1).
      const survivingIds = new Set(r.present.boards.map((b) => b.id))
      for (const b of s.boards) {
        if (!survivingIds.has(b.id) && idleOnMountIds.delete(b.id)) parkedIdleIds.add(b.id)
      }
      // BUG-012: re-promote the parked idle flag of every board this undo RESURRECTS (e.g.
      // undoing a DIRECT removeBoard of an idle terminal, which parked the flag) so the
      // restored board still mounts idle — the symmetric counterpart of redo's sweep.
      const priorIds = new Set(s.boards.map((b) => b.id))
      for (const b of r.present.boards) {
        if (!priorIds.has(b.id) && parkedIdleIds.delete(b.id)) idleOnMountIds.add(b.id)
      }
      gcParkedIdle(r.present.boards, r.past, r.future)
      return {
        boards: r.present.boards,
        connectors: r.present.connectors,
        groups: r.present.groups,
        past: r.past,
        future: r.future,
        selectedId: null,
        selectedIds: [],
        // configPendingId is ephemeral (never snapshotted on the undo rail). If this jump dropped
        // the awaiting-config terminal, the flag would dangle — prune it (the removeBoard guard
        // can't, since undo restores boards from a snapshot rather than calling removeBoard).
        ...(s.configPendingId && !survivingIds.has(s.configPendingId)
          ? { configPendingId: null }
          : {})
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
      pendingCheckpoint = null // see undo — a history jump stales the gesture checkpoint
      // BUG-012: boards this redo DROPS from the present (e.g. redoing a removeBoard of an
      // idle terminal) must park their flag too — mirrors undo's vanish sweep so an idle id
      // never strands on the live registry when its board is no longer present.
      const survivingIds = new Set(r.present.boards.map((b) => b.id))
      for (const b of s.boards) {
        if (!survivingIds.has(b.id) && idleOnMountIds.delete(b.id)) parkedIdleIds.add(b.id)
      }
      // BUG-012: re-add the parked idle flag of every board this redo RESURRECTS (the
      // symmetric counterpart of undo's sweep) so a redone terminal clone mounts idle.
      const priorIds = new Set(s.boards.map((b) => b.id))
      for (const b of r.present.boards) {
        if (!priorIds.has(b.id) && parkedIdleIds.delete(b.id)) idleOnMountIds.add(b.id)
      }
      gcParkedIdle(r.present.boards, r.past, r.future)
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
      get().groups,
      get().background
    ),
  loadObject: (doc) => {
    // Guard the deep-validation throw (corrupt board/element or too-new schemaVersion):
    // a raw-doc load with no dir can't do a .bak retry, so on a throw set status:'error'
    // (with the message) and leave board/connector/viewport state UNTOUCHED — do NOT null
    // the pending checkpoint or flag restored terminals until the parse succeeds. Matches
    // applyOpenResult's guard so a corrupt doc never throws out and blanks the app (T4).
    let d: ReturnType<typeof fromObject>
    try {
      d = fromObject(doc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed to load project'
      set((s) => ({ project: { ...s.project, status: 'error', error: msg } }))
      return
    }
    noticeIfNewerDoc(d)
    applyLoadedDoc(set, d)
  },
  setProjectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
  applyOpenResult: async (r) => {
    // #BUG-013: stamp this open with a generation token. The .bak-retry below awaits an
    // IPC round-trip; a second open can complete during that await, and this call's late
    // continuation must then discard its result instead of clobbering the newer project.
    const epoch = ++openEpoch
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
      // #BUG-013: a newer open superseded this one while the .bak retry was in flight —
      // drop the late result (neither apply the recovery nor stamp 'error' over it).
      if (epoch !== openEpoch) return
      if (bak.ok) {
        try {
          const d2 = fromObject(bak.doc)
          noticeIfNewerDoc(d2)
          applyLoadedDoc(set, d2, { dir: r.dir, name: r.name, status: 'open' })
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
    noticeIfNewerDoc(d)
    applyLoadedDoc(set, d, { dir: r.dir, name: r.name, status: 'open' })
  }
}))

/**
 * ADR 0007 forward-compatible open: a doc written by a newer app (additive bump) opens
 * fine, but the user should know features may be missing and that the next save
 * re-stamps the file at THIS app's version. Non-blocking info toast, keyed so a
 * project switch replaces rather than stacks it.
 */
function noticeIfNewerDoc(d: CanvasDoc): void {
  if (d.schemaVersion > SCHEMA_VERSION) {
    showToast({
      id: 'schema-forward-open',
      kind: 'info',
      message:
        `Project was saved by a newer version of the app (schema v${d.schemaVersion}). ` +
        `Opened in compatibility mode — saving re-stamps it at v${SCHEMA_VERSION}.`
    })
  }
}

/**
 * Machine-driven board patch (#BUG-057): same type-filtered merge as updateBoard but
 * HISTORY-NEUTRAL — records no checkpoint, leaves any pending gesture checkpoint armed,
 * and never clears an armed redo branch, so a background writer (the auto-connect detect
 * push, a 1s timer) can't silently kill the user's redo stack. An armed pendingCheckpoint
 * is REWRITTEN with the same patch (like patchBoardMeta): without that, a checkpoint
 * armed before this machine write snapshots the pre-patch board, and undoing the gesture
 * silently reverts the machine-written value. Mirrors growBoardHeight's untracked
 * contract. Module-scoped (like isIdleOnMount) rather than a CanvasState action: it is
 * for background engines, never user-gesture call sites.
 *
 * NOTE: unlike patchBoardMeta, the past/future snapshot rails are intentionally NOT
 * rewritten — an undo reverts any value written here. Acceptable only for callers whose
 * writes self-heal (useBrowserAutoConnect: the detect loop re-pushes next tick). Do NOT
 * use this for persistent fields that cannot self-heal; use patchBoardMeta's mapRail
 * pattern instead.
 */
export function patchBoardUntracked(id: string, patch: Partial<Board>): void {
  useCanvasStore.setState((s) => {
    const boards = applyBoardPatch(s.boards, id, patch)
    if (!boards) return s
    if (pendingCheckpoint) {
      const nb = applyBoardPatch(pendingCheckpoint.boards, id, patch)
      if (nb) pendingCheckpoint = { ...pendingCheckpoint, boards: nb }
    }
    return { boards }
  })
}

/**
 * MAIN-pushed recap metadata setter (#BUG-064, `recap:learned`). agentSessionId /
 * agentTranscriptPath are app-learned fields, not user-editable state, so the patch must
 * be invisible to undo/redo: it skips updateBoard's future-clear AND rewrites the
 * matching board inside every past/future snapshot (and any pending gesture checkpoint)
 * — a naive skip-only setter would leave stale values in old snapshots, so a later undo
 * silently reverted the learned metadata until the next learn event. Module-scoped for
 * the same reason as patchBoardUntracked.
 */
export function patchBoardMeta(
  id: string,
  meta: { agentSessionId?: string; agentTranscriptPath?: string }
): void {
  const applyMeta = (boards: Board[]): Board[] => {
    let changed = false
    const next = boards.map((b) => {
      if (b.id !== id || b.type !== 'terminal') return b
      const safe: Record<string, unknown> = {}
      let diff = false
      for (const key of ['agentSessionId', 'agentTranscriptPath'] as const) {
        if (key in meta && b[key] !== meta[key]) {
          safe[key] = meta[key]
          diff = true
        }
      }
      if (!diff) return b
      changed = true
      return { ...b, ...safe } as Board
    })
    return changed ? next : boards
  }
  const mapRail = (rail: CanvasSnapshot[]): CanvasSnapshot[] => {
    let railChanged = false
    const next = rail.map((snap) => {
      const nb = applyMeta(snap.boards)
      if (nb === snap.boards) return snap
      railChanged = true
      return { ...snap, boards: nb }
    })
    return railChanged ? next : rail
  }
  useCanvasStore.setState((s) => {
    const boards = applyMeta(s.boards)
    const past = mapRail(s.past)
    const future = mapRail(s.future)
    if (pendingCheckpoint) {
      const nb = applyMeta(pendingCheckpoint.boards)
      if (nb !== pendingCheckpoint.boards) pendingCheckpoint = { ...pendingCheckpoint, boards: nb }
    }
    if (boards === s.boards && past === s.past && future === s.future) return s
    return { boards, past, future }
  })
}

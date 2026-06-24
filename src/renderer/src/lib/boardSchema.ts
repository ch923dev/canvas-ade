/**
 * Board-data schema + (de)serialization (pure, no React, no Zustand).
 *
 * Every board is serialization-ready from birth: this module is the single source
 * of truth for the shape that gets persisted to `canvas.json` in Phase 3. For now
 * the round-trip (`toObject` / `fromObject`) is exercised in memory only — file I/O
 * is deferred. A root integer `schemaVersion` + an (empty today) migration pipeline
 * let us evolve the shape without breaking older project files later.
 *
 * Field-name note: boards use `w`/`h` (not `width`/`height`) — distinct from
 * `cameraBounds.Rect`, which is screen-geometry math, not persisted board data.
 */

import {
  FONT_FAMILY_TOKENS,
  FONT_SIZE_TOKENS,
  TEXT_ALIGN_TOKENS,
  TEXT_COLOR_TOKENS,
  type FontFamilyToken,
  type FontSizeToken,
  type TextAlignToken,
  type TextColorToken
} from '../canvas/boards/planning/textStyle'
import { MAX_TERMINAL_FONT, MIN_TERMINAL_FONT } from '../canvas/boards/terminal/terminalFont'
import { clampScrollback } from '../canvas/boards/terminal/terminalScrollback'
import { SCHEMA_VERSION, MIN_READER_VERSION } from './boardSchemaVersion'

/**
 * Bump on any breaking change to the persisted shape and add a migration below.
 *
 * SCHEMA-VERSION CLAIM:
 * - v5 = MCP M2 — spatial connectors.
 * - v6 = board groups (named board clusters, #84). Backfills an empty `groups` array.
 * - **v7 = free-text typography tokens** (fontFamily / fontSize / align / color / bold —
 *   all optional on TextElement; defaulted at render time). Identity migration (no
 *   backfill). #84 took v6 first, so this slice rebased v6 → v7 (ADR 0004).
 * - **v8 = optional TextElement.width** (area-text wrap-box width in board px). All-optional
 *   → identity bump; an existing text with no width renders as point text, byte-identical.
 * - **v9 = optional root `background`** (canvas backdrop — wallpaper/scene + dim/saturation/grid,
 *   see `docs/canvas-backdrop/`). Optional + defaulted-at-read → identity bump; absent reads as
 *   "none" (today's flat void, byte-identical for existing projects).
 * - **v10 = optional TerminalBoard `agentKind` + `monitorActivity`** (New Terminal agent presets).
 *   Both optional + defaulted-at-read → identity bump; ADDITIVE so MIN_READER_VERSION stays 9 (an
 *   older reader opens v10 docs; the two fields ride through `structuredClone` and survive a save).
 * - **v11 = the Planning `diagram` element kind** (S4 — Mermaid). NEW element kind ⇒ BREAKING
 *   (floor → 11): a pre-11 `assertPlanningElement` throws on the unknown kind. Identity migration.
 * - **v12 = the `command` board type** (Command board, Phase A). NEW board type ⇒ BREAKING
 *   (floor → 12): a pre-12 `assertBoard` throws on the unknown type. Identity migration; the board
 *   persists only `BoardCommon` (the orchestrator queue is ephemeral `commandStore` state).
 *   Do not silently reuse a version for a new shape.
 * - **v13 = the file-tree foundation** (S1). Adds BOTH the `'file'` BOARD type and the `'fileref'`
 *   Planning ELEMENT kind at once. Both are BREAKING (floor → 13): a pre-13 `assertBoard` /
 *   `assertPlanningElement` throws on the unknown type/kind. Identity migration (the new type/kind
 *   only appear on newly-authored content). The foundation slice owns the WHOLE v13 bump.
 * - **v14 = the `dataflow` board type** (JD-4 — Data-Flow board, JD umbrella close). NEW board type ⇒
 *   BREAKING (floor → 14): a pre-14 `assertBoard` throws on the unknown type. Identity migration; the
 *   board persists only `BoardCommon` + an optional `sourceBoardId` (the bound Browser board — mirrors
 *   `BrowserBoard.previewSourceId`). The inferred model is body-derived + EPHEMERAL (ADR 0010), never
 *   serialized; export to `.canvas/memory/` is the consent moment.
 */
// SCHEMA_VERSION + MIN_READER_VERSION are defined in ./boardSchemaVersion (a dependency-free module)
// so a main-side lock-step test can import the authoritative numbers without dragging in this file's
// DOM-bound deps (terminalFont -> window) under the node tsconfig (BUG-014). Re-exported here so every
// existing `import { SCHEMA_VERSION } from '.../boardSchema'` consumer is unchanged.
export { SCHEMA_VERSION, MIN_READER_VERSION }

/**
 * Two-tier versioning (ADR 0007): the compat floor stamped into every written doc as
 * `minReaderVersion` — the lowest SCHEMA_VERSION an app needs to read what we write.
 *
 * - ADDITIVE change (new OPTIONAL fields, defaulted at read): bump SCHEMA_VERSION only.
 *   Older readers (≥ this floor) still open the doc; unknown optional fields ride
 *   through fromObject's structuredClone and survive a save round-trip.
 * - BREAKING change (new board type / element kind, a semantic change an older
 *   validator rejects or misreads, or a NEW DOC-LEVEL KEY — toObject rebuilds the root
 *   object, so an older reader's save would DROP it): bump BOTH to the same value.
 *
 * Floor starts at 9: v9's root `background` key is exactly the doc-level case above — a
 * v8 reader would open the doc but silently DROP the user's wallpaper on its next save,
 * so v9 is the breaking baseline. Pre-9 apps keep their old strict refuse-on-newer
 * behavior; every app from 9 on can read all future additive docs.
 */
// MIN_READER_VERSION is imported + re-exported above from ./boardSchemaVersion (see BUG-013/014).

export type BoardType = 'terminal' | 'browser' | 'planning' | 'command' | 'file' | 'dataflow'

/** Browser responsive presets (widths live in cameraBounds/the Browser board). */
export type BrowserViewport = 'mobile' | 'tablet' | 'desktop'

/** Fields shared by every board type. `z` (stacking order) is optional. */
export interface BoardCommon {
  id: string
  type: BoardType
  x: number
  y: number
  w: number
  h: number
  title: string
  z?: number
}

export interface TerminalBoard extends BoardCommon {
  type: 'terminal'
  shell?: string
  launchCommand?: string
  cwd?: string
  port?: number
  /** App-learned (via the recap hook) Claude session id for this board. */
  agentSessionId?: string
  /**
   * App-learned absolute path to this board's transcript JSONL. MACHINE-LOCAL: like `cwd`, this
   * is a path on the machine that recorded it, so it is stale if the project folder is synced
   * (iCloud/Dropbox/NAS) and reopened elsewhere. Don't assume it's portable across machines.
   */
  agentTranscriptPath?: string
  /**
   * Per-board xterm font size in px. Absent => use the sticky default (else 12.5). Optional
   * + default-at-read => NO SCHEMA_VERSION bump (mirrors previewSourceId / agentSessionId).
   */
  fontSize?: number
  /**
   * Per-board xterm scrollback in lines (output retained above the viewport). Absent => the
   * sticky default (else 2000). Optional + default-at-read => NO SCHEMA_VERSION bump (mirrors
   * fontSize). Bounded [0, 50000] (perf cap SLICE-012 — xterm retains ~12 B/cell that never
   * releases); an out-of-band hand-edited value is clamped at read in fromObject.
   */
  scrollback?: number
  /**
   * v10: which agentic-CLI preset this terminal was created from (e.g. 'claude' | 'codex' |
   * 'gemini' | 'opencode' | 'shell' | a custom id). Identity metadata only — the actual exec
   * is still `launchCommand`. Free string (not a closed enum) so a custom/future preset needs
   * no schema bump; the renderer maps an unknown id to a generic glyph. Exposed to MCP via
   * `canvas://boards` so an orchestrator can route by capability.
   */
  agentKind?: string
  /**
   * v10: whether this terminal participates in activity monitoring (status/recap publish +
   * the MCP `canvas://attention` swarm queue). Absent ⇒ treated as `true` (opt-out, not
   * opt-in). `false` keeps a plain shell out of the orchestrator's view.
   */
  monitorActivity?: boolean
}

export interface BrowserBoard extends BoardCommon {
  type: 'browser'
  url: string
  viewport: BrowserViewport
  /** Slice C′: the Terminal board id that pushed this preview (the link/arrow source). */
  previewSourceId?: string
}

/**
 * v13: an on-canvas file viewer/editor board (file-tree epic). `path` is RELATIVE to the
 * project root (the same root every `file:*` IPC re-resolves against); absent ⇒ an UNBOUND
 * placeholder (no file opened yet — the dock creates one of these). File CONTENT is NOT
 * persisted — it is read live from disk via `window.api.file`, respecting the scene/session
 * split. `readOnly` (optional) marks a board the editor opens view-only (S3 consumes it).
 */
export interface FileBoard extends BoardCommon {
  type: 'file'
  /** Relative POSIX path to the file under the project root. Absent ⇒ unbound placeholder. */
  path?: string
  /** Open the file view-only (S3). Absent ⇒ editable. */
  readOnly?: boolean
}

// ── Planning elements (whiteboard content; 2.3 owns the rich impl) ────────────
// Discriminated on `kind` (boards discriminate on `type`) so the two unions never
// collide. These shapes are intentionally minimal — enough to be schema-stable;
// 2.3 may extend them behind a migration.

export type NoteTint = 'yellow' | 'blue' | 'green' | 'plain'

interface ElementCommon {
  id: string
  x: number
  y: number
  /** W3: resist move/erase/delete. Absent ⇒ unlocked (read as `el.locked ?? false`). */
  locked?: boolean
  /** W3: lightweight grouping (move/delete-together). Absent ⇒ ungrouped. */
  groupId?: string
}

export interface NoteElement extends ElementCommon {
  kind: 'note'
  text: string
  w: number
  h: number
  tint: NoteTint
  rotation?: number
}

export interface TextElement extends ElementCommon {
  kind: 'text'
  text: string
  fontFamily?: FontFamilyToken
  fontSize?: FontSizeToken
  align?: TextAlignToken
  color?: TextColorToken
  bold?: boolean
  /** v8: area-text wrap-box width (board px). Absent ⇒ point text (auto-size). */
  width?: number
}

export interface ArrowElement extends ElementCommon {
  kind: 'arrow'
  /** End point in the same coordinate space as (x, y) = the start point. */
  x2: number
  y2: number
}

export interface StrokeElement extends ElementCommon {
  kind: 'stroke'
  /** Flat point list [x0, y0, x1, y1, …] in board-local coordinates. */
  points: number[]
}

export interface ChecklistItem {
  id: string
  label: string
  done: boolean
}

export interface ChecklistElement extends ElementCommon {
  kind: 'checklist'
  title: string
  items: ChecklistItem[]
  w: number
  h: number
}

export interface ImageElement extends ElementCommon {
  kind: 'image'
  /** Display box (board-local px). */
  w: number
  h: number
  /** Relative POSIX path to the blob: `assets/<sha1>.<ext>` (never a base64 data URL). */
  assetId: string
}

/**
 * v11: a themed Mermaid diagram element (S4). `source` is canonical — the SVG is a DERIVED cache
 * (`svgCache`, a content-addressed `assets/<sha1>.svg`) re-rendered from the source by the hidden
 * MAIN worker; a source change invalidates it. Rendered as an inert `<img>` of the cached SVG,
 * exactly like ImageElement (≈80% reuse). A new element kind is breaking → schema v11 / floor 11.
 */
export interface DiagramElement extends ElementCommon {
  kind: 'diagram'
  /** Canonical diagram source text (Mermaid). */
  source: string
  /** Source dialect / render engine. Only 'mermaid' today; the field pins it for future engines. */
  engine: 'mermaid'
  /** Display box (board-local px). */
  w: number
  h: number
  /** Derived content-addressed SVG cache `assets/<sha1>.svg`. Absent ⇒ not yet rendered / pending;
   *  a source edit clears it and the renderer re-renders + rewrites it (a silent, non-undoable patch). */
  svgCache?: string
}

/**
 * v13: a Planning file-reference chip (file-tree epic). A clickable card that points at a
 * project file by RELATIVE path (same root as the `file:*` IPC); clicking it opens the file
 * as a File board (S4 wires the click + the drop-to-create gesture). `label` is the display
 * name (typically the basename). A new element kind is breaking → schema v13 / floor 13.
 */
export interface FileRefElement extends ElementCommon {
  kind: 'fileref'
  /** Relative POSIX path to the referenced file under the project root. */
  path: string
  /** Display label (typically the file's basename). */
  label: string
  /** Display box (board-local px). */
  w: number
  h: number
}

export type PlanningElement =
  | NoteElement
  | TextElement
  | ArrowElement
  | StrokeElement
  | ChecklistElement
  | ImageElement
  | DiagramElement
  | FileRefElement

export interface PlanningBoard extends BoardCommon {
  type: 'planning'
  elements: PlanningElement[]
}

/**
 * v12: the Command board — the orchestrator's on-canvas face (Phase A). A SINGLETON board that
 * (in later phases) drives the MCP orchestrator: decompose a task → spawn a Named Group of worker
 * boards → dispatch → collect/merge. The PERSISTED shape is just `BoardCommon` with `type:'command'`:
 * the task queue + view/collapse state live in the EPHEMERAL `commandStore` (Zustand, runtime-only)
 * and are NEVER serialized into `canvas.json` (the scene/session split). A new board type is breaking
 * → schema v12 / floor 12.
 */
export interface CommandBoard extends BoardCommon {
  type: 'command'
}

/**
 * v14: the Data-Flow board (JD-4) — a dedicated React-Flow board that visualizes the inferred API
 * surface (endpoints → schemas → entities → id-lineage) of a Browser board's captured traffic. Like
 * the Command board, the PERSISTED shape is just `BoardCommon` + one optional binding: `sourceBoardId`
 * names the Browser board whose OSR Network capture it analyzes (mirrors `BrowserBoard.previewSourceId`
 * — a board id, not body-derived data). The inferred model + view state (focus node, layout tab, diff
 * baseline) live in the EPHEMERAL `dataFlowStore` and are NEVER serialized (the scene/session split +
 * ADR 0010's "ephemeral by default; export is the consent moment"). Reopening a project shows an empty
 * "no captures yet" state until the bound Browser board re-captures. A new board type is breaking →
 * schema v14 / floor 14.
 */
export interface DataFlowBoard extends BoardCommon {
  type: 'dataflow'
  /** The Browser board whose captured traffic this board visualizes. Absent ⇒ unbound. */
  sourceBoardId?: string
}

export type Board =
  | TerminalBoard
  | BrowserBoard
  | PlanningBoard
  | CommandBoard
  | FileBoard
  | DataFlowBoard

// ── Connectors (M2 — spatial board↔board edges) ────────────────────────────────
// A typed cable between two boards. `preview` mirrors the runtime `previewSourceId`
// link (Browser ← its source terminal); `orchestration` is a user-drawn relationship
// the MCP dispatch layer (M4) later flows along. Generalizes PreviewEdge so the canvas
// renders both edge families from one derived-edge approach.

export type ConnectorKind = 'preview' | 'orchestration'

export interface Connector {
  id: string
  sourceId: string
  targetId: string
  kind: ConnectorKind
}

/**
 * A user-named set of boards for durable navigation/grouping purposes. A board may
 * belong to MANY groups (multi-membership is intentional). Named-empty groups survive
 * — a group whose boards were all deleted is kept so the user doesn't lose the name.
 * Forward-compatible with the deferred Feature Workspaces phase, which will add an
 * optional `worktreePath` to back the group with a git worktree.
 */
export interface NamedGroup {
  id: string
  name: string
  boardIds: string[]
}

/** Persisted camera transform. `null` in a doc means "fit on load". */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

// ── Canvas backdrop (schema v9) ────────────────────────────────────────────────

export type BackgroundKind = 'none' | 'file' | 'scene'
/** World-grid lattice style (PR 4 consumes `lines`/`cross`; absent reads as `dots`). */
export type GridStyle = 'dots' | 'lines' | 'cross'

export const BACKGROUND_DIM_RANGE = { min: 0, max: 0.85 } as const
export const BACKGROUND_SATURATION_RANGE = { min: 0.2, max: 1.2 } as const
export const DEFAULT_BACKGROUND_DIM = 0.25
export const DEFAULT_BACKGROUND_SATURATION = 0.7

/**
 * Per-project canvas backdrop (screen-fixed wallpaper layer, `docs/canvas-backdrop/`).
 * SETTINGS-CLASS state: persisted like `viewport`, NEVER on the undo rail. `scene` is a
 * registry id resolved at RENDER time (`canvas/backdrop/sceneRegistry`) — an id this build
 * does not know is preserved verbatim (forward-compat with newer preset packs) and the
 * layer renders plain void + a toast instead. Malformed backgrounds DEGRADE on load
 * (clamp / default / fall back to `none`) rather than failing the document — a cosmetic
 * field must never send a whole project to `.bak` recovery.
 */
export interface CanvasBackground {
  kind: BackgroundKind
  /** kind 'file': relative blob path `assets/<sha1>.<ext>` (same shape as ImageElement). */
  assetId?: string
  /** kind 'scene': bundled-scene registry id (e.g. 'blossom-river'). */
  scene?: string
  /** Optional palette variant of the scene; unknown values fall back to the scene default. */
  sceneVariant?: string
  /** Void-colored dim overlay alpha, clamped to [0, 0.85]. */
  dim: number
  /** CSS saturate() on the media/scene, clamped to [0.2, 1.2]. */
  saturation: number
  /** Keep the FadingDots grid above the backdrop. */
  gridDots: boolean
  /** Lattice style for the grid (PR 4); absent ⇒ 'dots'. */
  gridStyle?: GridStyle
}

/** The whole-canvas serialized document (root of `canvas.json`). */
export interface CanvasDoc {
  schemaVersion: number
  /**
   * Two-tier versioning (ADR 0007): the LOWEST SCHEMA_VERSION an app must support to
   * read this doc. Writers stamp MIN_READER_VERSION; an older app opens any doc whose
   * minReaderVersion ≤ its own SCHEMA_VERSION (additive bumps stay openable — deep
   * validation is the safety net). Optional: docs written before v8 lack it, and the
   * reader then falls back to schemaVersion (the old strict behavior).
   */
  minReaderVersion?: number
  viewport: CanvasViewport | null
  boards: Board[]
  /**
   * Typed board↔board connectors (M2, schema v5). `preview` connectors are derived
   * from each Browser's `previewSourceId` (still the runtime source of truth) and are
   * folded back on load — only `orchestration` connectors are carried in memory.
   */
  connectors: Connector[]
  /**
   * Named board groups (schema v6). Optional so a pre-migration v5 doc still parses;
   * the v5→v6 migration backfills `[]` and `fromObject` always returns a present array.
   */
  groups?: NamedGroup[]
  /**
   * Canvas backdrop (schema v9). Optional — absent means "none" (flat void), so older
   * docs and backdrop-less projects serialize byte-identically to pre-v9.
   */
  background?: CanvasBackground
}

// ── Sizes ─────────────────────────────────────────────────────────────────────

/** Smallest a board may be resized to (DESIGN.md §6). */
export const MIN_BOARD_SIZE = { w: 240, h: 160 } as const

/** Size a freshly-added board of each type gets (handoff 2.0-B). */
export const DEFAULT_BOARD_SIZE: Record<BoardType, { w: number; h: number }> = {
  terminal: { w: 420, h: 340 },
  browser: { w: 700, h: 500 },
  planning: { w: 516, h: 366 },
  // Wide enough for the five-column kanban body + the submit well + worker-pool strip (the
  // approved Phase-A production mock); collapses to a one-line rail when minimized.
  command: { w: 760, h: 440 },
  file: { w: 520, h: 380 },
  // Wide enough for the focus-on-node graph + the bottom legend strip (the approved JD-4 mock).
  dataflow: { w: 760, h: 520 }
}

const DEFAULT_TITLE: Record<BoardType, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  planning: 'Planning',
  command: 'Orchestrator',
  file: 'File',
  dataflow: 'Data Flow'
}

/** Seed URL for a new Browser board (basic edit lands in 2.2; port assignment Phase 3). */
const DEFAULT_BROWSER_URL = 'http://localhost:5173'

// ── Factory ─────────────────────────────────────────────────────────────────

export interface CreateBoardOpts {
  id: string
  x: number
  y: number
  title?: string
  w?: number
  h?: number
  z?: number
  /** File board only (v13): bind the new board to this RELATIVE path; omitted ⇒ unbound. */
  path?: string
  /** Data-Flow board only (v14): bind the new board to this Browser board id; omitted ⇒ unbound. */
  sourceBoardId?: string
}

/**
 * Build a fully-valid default board of `type`. Pure: the caller supplies the `id`
 * (the store generates one via `crypto.randomUUID()`), so this stays deterministic
 * and testable. Size/title default per type unless overridden.
 */
export function createBoard(type: BoardType, opts: CreateBoardOpts): Board {
  const size = DEFAULT_BOARD_SIZE[type]
  const base: BoardCommon = {
    id: opts.id,
    type,
    x: opts.x,
    y: opts.y,
    w: opts.w ?? size.w,
    h: opts.h ?? size.h,
    title: opts.title ?? DEFAULT_TITLE[type]
  }
  if (opts.z !== undefined) base.z = opts.z

  switch (type) {
    case 'terminal':
      return { ...base, type }
    case 'browser':
      return { ...base, type, url: DEFAULT_BROWSER_URL, viewport: 'desktop' }
    case 'planning':
      return { ...base, type, elements: [] }
    case 'command':
      // No per-type persisted fields — the orchestrator queue lives in the ephemeral commandStore.
      return { ...base, type }
    case 'file':
      // Unbound by default; openFileBoard passes opts.path to bind it to a file.
      return { ...base, type, ...(opts.path ? { path: opts.path } : {}) }
    case 'dataflow':
      // Unbound by default; the opener (DataFlowView "→ board") passes opts.sourceBoardId to bind it.
      return { ...base, type, ...(opts.sourceBoardId ? { sourceBoardId: opts.sourceBoardId } : {}) }
  }
}

// ── Serialization + migration ─────────────────────────────────────────────────

/**
 * Derive the `preview` connectors implied by board state: one per Browser board with a
 * present, non-dangling `previewSourceId`, with the STABLE id `preview-<browserId>`
 * (matches PreviewEdge's edge id). Pure; reused by the v4→v5 migration (fold-forward)
 * and the store's toObject (re-derive on every save). `previewSourceId` remains the
 * runtime source of truth — these connectors are derived from it, never the reverse.
 */
export function previewConnectorsFor(boards: Board[]): Connector[] {
  const ids = new Set(boards.map((b) => b.id))
  const out: Connector[] = []
  for (const b of boards) {
    if (b.type === 'browser' && b.previewSourceId && ids.has(b.previewSourceId)) {
      out.push({
        id: `preview-${b.id}`,
        sourceId: b.previewSourceId,
        targetId: b.id,
        kind: 'preview'
      })
    }
  }
  return out
}

/**
 * Boards + camera + connectors → a versioned document. `connectors` is the FULL set the
 * caller wants persisted (the store passes preview-derived + orchestration); it defaults
 * to `[]` so existing 2-arg callers and tests still produce a valid current-version doc.
 *
 * PERSIST-01: the returned doc ALIASES the caller's `boards`/`connectors`/`groups`/
 * `background` by reference — it does NOT deep-clone them. A deep clone here was pure
 * redundant work on every ~1s autosave tick (the audit's "3 deep passes per save"): the
 * two real consumers already own the isolation. The autosave + project-switch path hands
 * this doc to `window.api.project.save`, whose IPC boundary structured-clones it into
 * MAIN before writing; the read path (`fromObject`) structured-clones its input on the
 * way back in. CONTRACT: callers MUST treat the returned doc (and its nested arrays /
 * objects) as READ-ONLY — they share refs with live store state, which is itself only
 * ever replaced immutably, never mutated in place. (Mutating the doc would corrupt the
 * store and break undo / React change detection.)
 *
 * SCENE/SESSION CONTRACT: this is the ONLY thing persisted — {schemaVersion,
 * viewport, boards, connectors, groups}. Ephemeral session state (selected tool, selected
 * element, in-flight draft/erase, hover, the in-flight "connecting" gesture) lives in
 * React/Zustand and MUST NEVER be routed into `board.elements[]`, a board patch key,
 * or `connectors[]`, or it bloats every autosave and resurrects stale state on reload.
 * (Excalidraw's cleanAppStateForExport discipline, enforced here by omission.)
 */
export function toObject(
  boards: Board[],
  viewport: CanvasViewport | null,
  connectors: Connector[] = [],
  groups: NamedGroup[] = [],
  background: CanvasBackground | null = null
): CanvasDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    // viewport is a tiny {x,y,zoom} — a shallow copy is O(1) (not a "deep pass") and
    // keeps the live camera object from aliasing into the doc.
    viewport: viewport ? { ...viewport } : null,
    boards,
    connectors,
    groups,
    // Omit when unset so a backdrop-less project's canvas.json stays byte-identical to v8.
    ...(background ? { background } : {})
  }
}

type Migration = (doc: CanvasDoc) => CanvasDoc

/** Keyed by the FROM version. Each step returns a doc one version higher. */
const MIGRATIONS: Record<number, Migration> = {
  // v1 had no camera. v2 adds `viewport` (null = fit on load).
  1: (doc) => ({ ...doc, schemaVersion: 2, viewport: (doc as CanvasDoc).viewport ?? null }),
  // v3 adds OPTIONAL element `locked?`/`groupId?` (W3). No backfill: absent reads as
  // unlocked/ungrouped, so the migration only bumps the version.
  2: (doc) => ({ ...doc, schemaVersion: 3 }),
  // v4 adds the OPTIONAL image element (W4). assetId lives only on new image elements,
  // so there is nothing to backfill — the migration only bumps the version.
  3: (doc) => ({ ...doc, schemaVersion: 4 }),
  // v5 adds `connectors` (M2). Backfill: fold each Browser's present + valid
  // previewSourceId into a `preview` connector (the stable preview-<id>), so an older
  // project's preview links survive into the connector model. `previewSourceId` is left
  // on the board untouched (it stays the runtime source of truth — Decision B).
  4: (doc) => ({ ...doc, schemaVersion: 5, connectors: previewConnectorsFor(doc.boards) }),
  // v6 adds `groups` (named board clusters). Backfill an empty array — older projects
  // have no groups. Boards/connectors are untouched.
  5: (doc) => ({ ...doc, schemaVersion: 6, groups: (doc as CanvasDoc).groups ?? [] }),
  // v7: free-text typography tokens (all optional → identity bump; defaulted at render).
  6: (doc) => ({ ...doc, schemaVersion: 7 }),
  // v8: optional TextElement.width (area-text wrap box). All-optional → identity bump;
  // an existing text with no width renders as point text, byte-identical.
  7: (doc) => ({ ...doc, schemaVersion: 8 }),
  // v9: optional root `background` (canvas backdrop). Optional + defaulted-at-read →
  // identity bump; absent reads as "none" so existing projects render unchanged.
  8: (doc) => ({ ...doc, schemaVersion: 9 }),
  // v10: optional TerminalBoard agentKind + monitorActivity (agent presets). All-optional →
  // identity bump; absent agentKind reads as "no preset", absent monitorActivity reads as true.
  9: (doc) => ({ ...doc, schemaVersion: 10 }),
  // v11: the `diagram` element kind (S4). The kind only appears on newly-authored diagram elements,
  // so existing docs have nothing to backfill — the migration only bumps the version. BREAKING
  // (floor → 11): a pre-11 reader can't validate the new kind (boardSchemaVersion.ts).
  10: (doc) => ({ ...doc, schemaVersion: 11 }),
  // v12: the `command` board type (Phase A). The type only appears on newly-authored command boards,
  // so existing docs have nothing to backfill — the migration only bumps the version. BREAKING
  // (floor → 12): a pre-12 reader's assertBoard default branch throws on the unknown type.
  11: (doc) => ({ ...doc, schemaVersion: 12 }),
  // v13: the `file` board type AND `fileref` element kind (file-tree S1). Both only appear on
  // newly-authored content, so existing docs have nothing to backfill — identity bump. BREAKING
  // (floor → 13): a pre-13 reader can't validate either new type/kind (boardSchemaVersion.ts).
  12: (doc) => ({ ...doc, schemaVersion: 13 }),
  // v14: the `dataflow` board type (JD-4). The type only appears on newly-authored boards, so existing
  // docs have nothing to backfill — identity bump. BREAKING (floor → 14): a pre-14 reader's assertBoard
  // default branch throws on the unknown type (boardSchemaVersion.ts).
  13: (doc) => ({ ...doc, schemaVersion: 14 })
}

/**
 * Bring a document up to `SCHEMA_VERSION` by applying migrations in order. A doc
 * already at the current version passes through unchanged (no-op). Throws on a
 * missing version or a gap with no migration.
 *
 * NEWER docs (ADR 0007): a doc written by a newer app is OPENED AS-IS when its
 * `minReaderVersion` ≤ our SCHEMA_VERSION — every version between ours and the
 * writer's was additive, deep validation (fromObject) remains the safety net, and
 * unknown optional fields survive a save round-trip via the structuredClone
 * passthrough. Only a doc whose compat floor is above us (a true breaking change —
 * or a pre-floor doc with no `minReaderVersion`) is refused.
 */
/**
 * Refuse a doc whose compat floor is above this build (or a newer doc with no floor —
 * pre-ADR-0007 strict behavior). Shared by migrate() AND fromObject's early gate:
 * fromObject must run this BEFORE deep validation, or a breaking-change doc carrying a
 * new board type dies in assertBoard ("unknown type") and the user never sees the
 * actionable update-the-app message (review r1 finding on #134).
 */
function assertReadableVersion(doc: CanvasDoc): void {
  if (doc.schemaVersion <= SCHEMA_VERSION) return
  const floor = typeof doc.minReaderVersion === 'number' ? doc.minReaderVersion : doc.schemaVersion
  if (floor > SCHEMA_VERSION) {
    throw new Error(
      `migrate: document schemaVersion ${doc.schemaVersion} (requires reader ≥ ${floor}) ` +
        `is newer than supported ${SCHEMA_VERSION} — this project was saved by a newer ` +
        `version of the app; update the app to open it`
    )
  }
}

export function migrate(doc: CanvasDoc): CanvasDoc {
  if (typeof doc?.schemaVersion !== 'number') {
    throw new Error('migrate: document is missing an integer schemaVersion')
  }
  if (doc.schemaVersion > SCHEMA_VERSION) {
    assertReadableVersion(doc)
    // Forward-compatible open: keep the doc untouched (including its newer version
    // stamp — truthful until the next save re-stamps it at OUR version).
    return doc
  }
  let d = doc
  while (d.schemaVersion < SCHEMA_VERSION) {
    const step = MIGRATIONS[d.schemaVersion]
    if (!step) throw new Error(`migrate: no migration from schemaVersion ${d.schemaVersion}`)
    d = step(d)
  }
  return d
}

function isCanvasDoc(doc: unknown): doc is CanvasDoc {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    typeof (doc as CanvasDoc).schemaVersion === 'number' &&
    Array.isArray((doc as CanvasDoc).boards)
  )
}

// ── Deep runtime validation (fix #5) ────────────────────────────────────────────
// The envelope check (schemaVersion + boards[]) is not enough: a parseable but
// corrupt board/element would slip through and crash a consumer later, bypassing
// the Phase-3 `canvas.json.bak` fallback. These hand-rolled guards reject any board
// or element that does not match the schema above, so `fromObject` throws and the
// persistence layer can fall back to the backup. Kept dependency-free (no zod) to
// match the rest of this module.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Finite AND strictly positive — a real (non-degenerate, non-inverted) size. */
function isPositiveNum(v: unknown): v is number {
  return isFiniteNum(v) && v > 0
}

/** A valid persisted viewport: finite x/y and a finite, strictly-positive zoom. */
function isValidViewport(v: unknown): v is CanvasViewport {
  return (
    isRecord(v) &&
    isFiniteNum(v.x) &&
    isFiniteNum(v.y) &&
    isFiniteNum(v.zoom) &&
    (v.zoom as number) > 0
  )
}

function fail(msg: string): never {
  throw new Error(`fromObject: ${msg}`)
}

const VIEWPORTS: readonly BrowserViewport[] = ['mobile', 'tablet', 'desktop']
const NOTE_TINTS: readonly NoteTint[] = ['yellow', 'blue', 'green', 'plain']

/**
 * Validate a single planning element by `kind`; throws on any mismatch. Exported so the MCP
 * command applier (`useMcpCommands`) can re-validate every agent-materialized element as
 * defense in depth before it lands on a board (S2 — content written via the MCP path).
 */
export function assertPlanningElement(el: unknown): void {
  if (!isRecord(el)) fail('planning element is not an object')
  if (typeof el.id !== 'string') fail('planning element has a non-string id')
  if (!isFiniteNum(el.x) || !isFiniteNum(el.y)) fail('planning element has non-finite x/y')
  if (el.locked !== undefined && typeof el.locked !== 'boolean') {
    fail('planning element has a non-boolean locked')
  }
  if (el.groupId !== undefined && typeof el.groupId !== 'string') {
    fail('planning element has a non-string groupId')
  }

  switch (el.kind) {
    case 'note':
      if (typeof el.text !== 'string') fail('note element is missing string text')
      if (!isPositiveNum(el.w) || !isPositiveNum(el.h)) fail('note element has non-positive w/h')
      if (!NOTE_TINTS.includes(el.tint as NoteTint))
        fail(`note element has invalid tint ${el.tint}`)
      if (el.rotation !== undefined && !isFiniteNum(el.rotation)) {
        fail('note element has a non-finite rotation')
      }
      return
    case 'text':
      if (typeof el.text !== 'string') fail('text element is missing string text')
      if (
        el.fontFamily !== undefined &&
        !FONT_FAMILY_TOKENS.includes(el.fontFamily as FontFamilyToken)
      )
        fail(`text element has invalid fontFamily ${String(el.fontFamily)}`)
      if (el.fontSize !== undefined && !FONT_SIZE_TOKENS.includes(el.fontSize as FontSizeToken))
        fail(`text element has invalid fontSize ${String(el.fontSize)}`)
      if (el.align !== undefined && !TEXT_ALIGN_TOKENS.includes(el.align as TextAlignToken))
        fail(`text element has invalid align ${String(el.align)}`)
      if (el.color !== undefined && !TEXT_COLOR_TOKENS.includes(el.color as TextColorToken))
        fail(`text element has invalid color ${String(el.color)}`)
      if (el.bold !== undefined && typeof el.bold !== 'boolean')
        fail('text element has non-boolean bold')
      if (el.width !== undefined && !isPositiveNum(el.width))
        fail(`text element has non-positive width ${String(el.width)}`)
      return
    case 'arrow':
      if (!isFiniteNum(el.x2) || !isFiniteNum(el.y2)) fail('arrow element has non-finite x2/y2')
      return
    case 'stroke': {
      const pts = el.points
      if (!Array.isArray(pts)) fail('stroke element points is not an array')
      if (pts.length % 2 !== 0) fail('stroke element points has odd length')
      if (!pts.every(isFiniteNum)) fail('stroke element points has a non-finite value')
      return
    }
    case 'checklist': {
      if (typeof el.title !== 'string') fail('checklist element is missing string title')
      // w must be a real positive width; h is content-driven and legitimately seeded
      // as 0 (elements.ts), so h is exempt from the positivity guard — finite + >= 0.
      if (!isPositiveNum(el.w)) fail('checklist element has non-positive w')
      if (!isFiniteNum(el.h) || el.h < 0) fail('checklist element has non-finite/negative h')
      if (!Array.isArray(el.items)) fail('checklist element items is not an array')
      for (const item of el.items) {
        if (
          !isRecord(item) ||
          typeof item.id !== 'string' ||
          typeof item.label !== 'string' ||
          typeof item.done !== 'boolean'
        ) {
          fail('checklist element has a malformed item')
        }
      }
      return
    }
    case 'image':
      if (!isPositiveNum(el.w) || !isPositiveNum(el.h)) fail('image element has non-positive w/h')
      if (typeof el.assetId !== 'string' || el.assetId.length === 0) {
        fail('image element has an empty/non-string assetId')
      }
      return
    case 'diagram':
      if (typeof el.source !== 'string') fail('diagram element is missing string source')
      if (el.engine !== 'mermaid')
        fail(`diagram element has unsupported engine ${String(el.engine)}`)
      if (!isPositiveNum(el.w) || !isPositiveNum(el.h)) fail('diagram element has non-positive w/h')
      // svgCache is an OPTIONAL derived cache: absent (not-yet-rendered) is valid; present must be a
      // non-empty assetId-shaped string. The asset GC (collectAssetIds) keeps it from being swept.
      if (
        el.svgCache !== undefined &&
        (typeof el.svgCache !== 'string' || el.svgCache.length === 0)
      ) {
        fail('diagram element has an empty/non-string svgCache')
      }
      return
    case 'fileref':
      if (typeof el.path !== 'string' || el.path.length === 0) {
        fail('fileref element has an empty/non-string path')
      }
      if (typeof el.label !== 'string' || el.label.length === 0) {
        fail('fileref element has an empty/non-string label')
      }
      if (!isPositiveNum(el.w) || !isPositiveNum(el.h)) fail('fileref element has non-positive w/h')
      return
    default:
      fail(`planning element has an unknown kind ${String(el.kind)}`)
  }
}

/** Validate one board (common fields + per-type fields); throws on any mismatch. */
function assertBoard(b: unknown): void {
  if (!isRecord(b)) fail('board is not an object')
  if (typeof b.id !== 'string') fail('board has a non-string id')
  if (typeof b.title !== 'string') fail('board has a non-string title')
  if (!isFiniteNum(b.x) || !isFiniteNum(b.y)) fail('board has non-finite position (x/y)')
  // w/h must be real positive sizes — a finite-but-degenerate 0/negative would render
  // a zero-size or inverted board (#BUG-025). The MIN_BOARD_SIZE floor is clamped (not
  // rejected) on load in fromObject so below-min-but-valid data isn't dropped.
  if (!isPositiveNum(b.w) || !isPositiveNum(b.h)) fail('board has non-positive size (w/h)')
  if (b.z !== undefined && !isFiniteNum(b.z)) fail('board has a non-finite z')

  switch (b.type) {
    case 'terminal':
      if (b.shell !== undefined && typeof b.shell !== 'string')
        fail('terminal shell is not a string')
      if (b.launchCommand !== undefined && typeof b.launchCommand !== 'string') {
        fail('terminal launchCommand is not a string')
      }
      if (b.cwd !== undefined && typeof b.cwd !== 'string') fail('terminal cwd is not a string')
      if (b.port !== undefined && !isFiniteNum(b.port)) fail('terminal port is not a number')
      if (b.agentSessionId !== undefined && typeof b.agentSessionId !== 'string') {
        fail('terminal agentSessionId is not a string')
      }
      if (b.agentTranscriptPath !== undefined && typeof b.agentTranscriptPath !== 'string') {
        fail('terminal agentTranscriptPath is not a string')
      }
      if (b.fontSize !== undefined && !isPositiveNum(b.fontSize)) {
        fail('terminal fontSize must be a positive number')
      }
      if (b.scrollback !== undefined && (!isFiniteNum(b.scrollback) || b.scrollback < 0)) {
        fail('terminal scrollback must be a non-negative number')
      }
      if (b.agentKind !== undefined && typeof b.agentKind !== 'string') {
        fail('terminal agentKind is not a string')
      }
      if (b.monitorActivity !== undefined && typeof b.monitorActivity !== 'boolean') {
        fail('terminal monitorActivity is not a boolean')
      }
      return
    case 'browser':
      if (typeof b.url !== 'string') fail('browser board is missing a string url')
      if (!VIEWPORTS.includes(b.viewport as BrowserViewport)) {
        fail(`browser board has an invalid viewport ${String(b.viewport)}`)
      }
      if (b.previewSourceId !== undefined && typeof b.previewSourceId !== 'string') {
        fail('browser previewSourceId is not a string')
      }
      return
    case 'planning':
      if (!Array.isArray(b.elements)) fail('planning board elements is not an array')
      b.elements.forEach(assertPlanningElement)
      return
    case 'command':
      // v12: the Command board persists no per-type fields — the orchestrator queue is ephemeral
      // commandStore state. The common-field checks above (id/title/x/y/w/h/z) are the whole contract.
      return
    case 'file':
      // path is optional (absent = unbound placeholder); when present it must be a string
      // — MAIN re-validates + root-confines it on every file:* op (the renderer trusts no
      // path), so this is a shape check, not a containment check.
      if (b.path !== undefined && typeof b.path !== 'string')
        fail('file board path is not a string')
      if (b.readOnly !== undefined && typeof b.readOnly !== 'boolean') {
        fail('file board readOnly is not a boolean')
      }
      return
    case 'dataflow':
      // v14: sourceBoardId is optional (absent = unbound). When present it must be a string; a
      // dangling/non-browser binding is dropped in fromObject (mirrors previewSourceId), so this
      // is a shape check only. No persisted body-derived data (the inferred model is ephemeral).
      if (b.sourceBoardId !== undefined && typeof b.sourceBoardId !== 'string') {
        fail('dataflow board sourceBoardId is not a string')
      }
      return
    default:
      fail(`board has an unknown type ${String(b.type)}`)
  }
}

const CONNECTOR_KINDS: readonly ConnectorKind[] = ['preview', 'orchestration']

/** Validate one connector (id/sourceId/targetId strings + a known kind); throws on mismatch. */
function assertConnector(c: unknown): void {
  if (!isRecord(c)) fail('connector is not an object')
  if (typeof c.id !== 'string') fail('connector has a non-string id')
  if (typeof c.sourceId !== 'string') fail('connector has a non-string sourceId')
  if (typeof c.targetId !== 'string') fail('connector has a non-string targetId')
  if (!CONNECTOR_KINDS.includes(c.kind as ConnectorKind)) {
    fail(`connector has an invalid kind ${String(c.kind)}`)
  }
}

/** Validate one group (id/name strings + a string[] boardIds); throws on mismatch. */
function assertGroup(g: unknown): void {
  if (!isRecord(g)) fail('group is not an object')
  if (typeof g.id !== 'string') fail('group has a non-string id')
  if (typeof g.name !== 'string') fail('group has a non-string name')
  if (!Array.isArray(g.boardIds)) fail('group boardIds is not an array')
  for (const bid of g.boardIds as unknown[]) {
    if (typeof bid !== 'string') fail('group boardIds contains a non-string entry')
  }
}

/**
 * Reconcile a migrated doc's groups: validates each group, then prunes dangling
 * boardIds (pointing at boards that no longer exist) AND de-duplicates — `boardIds`
 * is set-semantic (a board either belongs or it doesn't), matching the store's
 * `addBoardsToGroup` write-path dedup. Named-empty groups survive — a group whose
 * boards were all deleted is kept so the user does not lose the name. Missing `groups`
 * field (pre-migration or stripped) defaults to `[]`.
 */
function reconcileGroups(doc: CanvasDoc): NamedGroup[] {
  const raw = Array.isArray(doc.groups) ? doc.groups : []
  raw.forEach(assertGroup)
  const ids = new Set(doc.boards.map((b) => b.id))
  return (raw as NamedGroup[]).map((g) => ({
    ...g,
    boardIds: [...new Set(g.boardIds.filter((bid) => ids.has(bid)))]
  }))
}

/**
 * Reconcile a migrated doc's connectors into the in-memory shape (Decision B,
 * dual-source). Validates every connector, drops danglers (an endpoint board is gone),
 * folds each `preview` connector BACK into its target Browser's `previewSourceId` (the
 * runtime source of truth) and then DROPS it — only `orchestration` connectors are kept
 * in memory. Mutates `doc.boards` (the fold-back) and returns the kept connectors.
 */
function reconcileConnectors(doc: CanvasDoc): Connector[] {
  const raw = Array.isArray(doc.connectors) ? doc.connectors : []
  raw.forEach(assertConnector)
  const ids = new Set(doc.boards.map((b) => b.id))
  const kept: Connector[] = []
  for (const c of raw as Connector[]) {
    if (!ids.has(c.sourceId) || !ids.has(c.targetId)) continue // dangling → drop
    if (c.kind === 'preview') {
      // Fold back: ensure the target Browser carries the previewSourceId, then drop the
      // connector — previewSourceId is the SoT, the connector is derived on next save.
      // Guard: only fold if the source board is a terminal (BUG-022) — a non-terminal
      // source would produce a permanently-stale edge that can never be live.
      const src = doc.boards.find((b) => b.id === c.sourceId)
      const tgt = doc.boards.find((b) => b.id === c.targetId)
      if (src && src.type === 'terminal' && tgt && tgt.type === 'browser' && !tgt.previewSourceId) {
        tgt.previewSourceId = c.sourceId
      }
      continue
    }
    kept.push(c)
  }
  return kept
}

const BACKGROUND_KINDS: readonly BackgroundKind[] = ['none', 'file', 'scene']
const GRID_STYLES: readonly GridStyle[] = ['dots', 'lines', 'cross']

const clampTo = (v: number, r: { min: number; max: number }): number =>
  Math.min(r.max, Math.max(r.min, v))

/**
 * Reconcile a migrated doc's backdrop. DEGRADES instead of failing: the backdrop is
 * cosmetic, so a malformed value must never reject the document (boards always win) —
 * unlike assertBoard/assertConnector this never throws. Rules:
 * - not a record / unknown kind → undefined (renders as "none")
 * - kind 'file' without a non-empty string assetId → kind 'none' (assetId dropped)
 * - kind 'scene' without a non-empty string scene id → kind 'none'; a WELL-FORMED but
 *   unrecognized scene id is preserved verbatim (forward-compat — the render layer
 *   resolves unknown ids to void + toast, see CanvasBackground docs)
 * - dim/saturation non-finite → defaults; out-of-band → clamped
 * - gridDots non-boolean → false; gridStyle outside the union → dropped (reads as 'dots')
 */
function reconcileBackground(doc: CanvasDoc): CanvasBackground | undefined {
  const raw = (doc as { background?: unknown }).background
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) return undefined
  if (!BACKGROUND_KINDS.includes(raw.kind as BackgroundKind)) return undefined

  let kind = raw.kind as BackgroundKind
  const assetId =
    typeof raw.assetId === 'string' && raw.assetId.length > 0 ? raw.assetId : undefined
  const scene = typeof raw.scene === 'string' && raw.scene.length > 0 ? raw.scene : undefined
  const sceneVariant =
    typeof raw.sceneVariant === 'string' && raw.sceneVariant.length > 0
      ? raw.sceneVariant
      : undefined
  if (kind === 'file' && !assetId) kind = 'none'
  if (kind === 'scene' && !scene) kind = 'none'

  return {
    kind,
    ...(kind === 'file' && assetId ? { assetId } : {}),
    ...(kind === 'scene' && scene ? { scene } : {}),
    ...(kind === 'scene' && scene && sceneVariant ? { sceneVariant } : {}),
    dim: isFiniteNum(raw.dim) ? clampTo(raw.dim, BACKGROUND_DIM_RANGE) : DEFAULT_BACKGROUND_DIM,
    saturation: isFiniteNum(raw.saturation)
      ? clampTo(raw.saturation, BACKGROUND_SATURATION_RANGE)
      : DEFAULT_BACKGROUND_SATURATION,
    gridDots: typeof raw.gridDots === 'boolean' ? raw.gridDots : false,
    ...(GRID_STYLES.includes(raw.gridStyle as GridStyle)
      ? { gridStyle: raw.gridStyle as GridStyle }
      : {})
  }
}

/** Parse + migrate an unknown value into a current-version document. */
export function fromObject(doc: unknown): CanvasDoc {
  if (!isCanvasDoc(doc)) {
    throw new Error('fromObject: value is not a CanvasDoc (need numeric schemaVersion + boards[])')
  }
  // ADR 0007: refuse an above-floor doc BEFORE deep validation, so a breaking-change
  // doc (e.g. a new board type from a future schema) surfaces the actionable
  // "update the app" message instead of assertBoard's "unknown type" (#134 review r1).
  assertReadableVersion(doc)
  doc.boards.forEach(assertBoard)
  // Own the data: deep-clone the input so the returned doc (and any store it feeds)
  // does not alias the caller's object — symmetric with toObject's structuredClone,
  // and covers the no-migration (already-current) case which migrate() returns by
  // reference (#BUG-027).
  const owned = structuredClone(doc)
  // Clamp each board to the MIN_BOARD_SIZE floor — assertBoard already rejects
  // non-positive w/h, but a valid-yet-below-minimum size (e.g. w:5) is normalized
  // here rather than dropped, so corrupt-but-recoverable input still loads (#BUG-025).
  // A terminal fontSize is normalized the same way: assertBoard rejects non-positive,
  // and an out-of-band-but-positive value (e.g. 0.001 or 999 from a hand-edited
  // canvas.json) is clamped to the [MIN,MAX] band here so the stored value matches
  // what renders — rather than passing validation and silently snapping at use.
  for (const b of owned.boards) {
    b.w = Math.max(MIN_BOARD_SIZE.w, b.w)
    b.h = Math.max(MIN_BOARD_SIZE.h, b.h)
    if (b.type === 'terminal' && b.fontSize !== undefined) {
      b.fontSize = Math.min(MAX_TERMINAL_FONT, Math.max(MIN_TERMINAL_FONT, b.fontSize))
    }
    if (b.type === 'terminal' && b.scrollback !== undefined) {
      b.scrollback = clampScrollback(b.scrollback)
    }
  }
  // Drop a preview link whose source board is no longer present (Slice C′) — a
  // dangling link must not render a half-edge; clear it rather than fail the load.
  // Also drop a link whose source board exists but is not a terminal (BUG-022):
  // a non-terminal source can never appear in terminalRuntimeStore, so its edge
  // would be permanently stale and misleading.
  const terminalIdSet = new Set(owned.boards.filter((b) => b.type === 'terminal').map((b) => b.id))
  for (const b of owned.boards) {
    if (b.type === 'browser' && b.previewSourceId && !terminalIdSet.has(b.previewSourceId)) {
      delete b.previewSourceId
    }
  }
  // v14: drop a Data-Flow board's sourceBoardId if its bound source is gone OR is not a Browser
  // board — a dataflow board only ever visualizes a Browser board's capture, so a non-browser /
  // dangling binding is a stale half-link (mirrors the previewSourceId reconcile above). Clear it
  // rather than fail the load; the board reopens unbound and the user re-binds.
  const browserIdSet = new Set(owned.boards.filter((b) => b.type === 'browser').map((b) => b.id))
  for (const b of owned.boards) {
    if (b.type === 'dataflow' && b.sourceBoardId && !browserIdSet.has(b.sourceBoardId)) {
      delete b.sourceBoardId
    }
  }
  const migrated = migrate(owned)
  // Reconcile connectors (M2): validate, strip danglers, fold preview→previewSourceId,
  // keep orchestration only in memory (Decision B). Runs post-migrate so a v4 doc's
  // freshly-folded preview connectors are reconciled the same as a v5 doc's.
  migrated.connectors = reconcileConnectors(migrated)
  // Reconcile groups (v6): validate, prune dangling boardIds, keep named-empty groups.
  // Runs post-migrate so a v5 doc's freshly-backfilled `[]` is handled like a v6 doc's.
  migrated.groups = reconcileGroups(migrated)
  // Reconcile the backdrop (v9): degrade-don't-reject (see reconcileBackground). Delete
  // the key entirely when it degrades to nothing so the doc matches a backdrop-less save.
  const background = reconcileBackground(migrated)
  if (background) migrated.background = background
  else delete migrated.background
  // A corrupt camera shouldn't fail the whole load — drop to fit-on-load.
  if (!isValidViewport(migrated.viewport)) migrated.viewport = null
  return migrated
}

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
 *   Do not silently reuse a version for a new shape.
 */
export const SCHEMA_VERSION = 8

export type BoardType = 'terminal' | 'browser' | 'planning'

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
}

export interface BrowserBoard extends BoardCommon {
  type: 'browser'
  url: string
  viewport: BrowserViewport
  /** Slice C′: the Terminal board id that pushed this preview (the link/arrow source). */
  previewSourceId?: string
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

export type PlanningElement =
  | NoteElement
  | TextElement
  | ArrowElement
  | StrokeElement
  | ChecklistElement
  | ImageElement

export interface PlanningBoard extends BoardCommon {
  type: 'planning'
  elements: PlanningElement[]
}

export type Board = TerminalBoard | BrowserBoard | PlanningBoard

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

/** The whole-canvas serialized document (root of `canvas.json`). */
export interface CanvasDoc {
  schemaVersion: number
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
}

// ── Sizes ─────────────────────────────────────────────────────────────────────

/** Smallest a board may be resized to (DESIGN.md §6). */
export const MIN_BOARD_SIZE = { w: 240, h: 160 } as const

/** Size a freshly-added board of each type gets (handoff 2.0-B). */
export const DEFAULT_BOARD_SIZE: Record<BoardType, { w: number; h: number }> = {
  terminal: { w: 420, h: 340 },
  browser: { w: 700, h: 500 },
  planning: { w: 516, h: 366 }
}

const DEFAULT_TITLE: Record<BoardType, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  planning: 'Planning'
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
 * Boards + camera + connectors → a versioned document. Deep-clones so the doc owns its
 * data. `connectors` is the FULL set the caller wants persisted (the store passes
 * preview-derived + orchestration); it defaults to `[]` so existing 2-arg callers and
 * tests still produce a valid current-version doc.
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
  groups: NamedGroup[] = []
): CanvasDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: viewport ? { ...viewport } : null,
    boards: structuredClone(boards),
    connectors: structuredClone(connectors),
    groups: structuredClone(groups)
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
  7: (doc) => ({ ...doc, schemaVersion: 8 })
}

/**
 * Bring a document up to `SCHEMA_VERSION` by applying migrations in order. A doc
 * already at the current version passes through unchanged (no-op). Throws on a
 * missing version, a gap with no migration, or a doc newer than we support.
 */
export function migrate(doc: CanvasDoc): CanvasDoc {
  if (typeof doc?.schemaVersion !== 'number') {
    throw new Error('migrate: document is missing an integer schemaVersion')
  }
  if (doc.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `migrate: document schemaVersion ${doc.schemaVersion} is newer than supported ${SCHEMA_VERSION}`
    )
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

/** Validate a single planning element by `kind`; throws on any mismatch. */
function assertPlanningElement(el: unknown): void {
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

/** Parse + migrate an unknown value into a current-version document. */
export function fromObject(doc: unknown): CanvasDoc {
  if (!isCanvasDoc(doc)) {
    throw new Error('fromObject: value is not a CanvasDoc (need numeric schemaVersion + boards[])')
  }
  doc.boards.forEach(assertBoard)
  // Own the data: deep-clone the input so the returned doc (and any store it feeds)
  // does not alias the caller's object — symmetric with toObject's structuredClone,
  // and covers the no-migration (already-current) case which migrate() returns by
  // reference (#BUG-027).
  const owned = structuredClone(doc)
  // Clamp each board to the MIN_BOARD_SIZE floor — assertBoard already rejects
  // non-positive w/h, but a valid-yet-below-minimum size (e.g. w:5) is normalized
  // here rather than dropped, so corrupt-but-recoverable input still loads (#BUG-025).
  for (const b of owned.boards) {
    b.w = Math.max(MIN_BOARD_SIZE.w, b.w)
    b.h = Math.max(MIN_BOARD_SIZE.h, b.h)
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
  const migrated = migrate(owned)
  // Reconcile connectors (M2): validate, strip danglers, fold preview→previewSourceId,
  // keep orchestration only in memory (Decision B). Runs post-migrate so a v4 doc's
  // freshly-folded preview connectors are reconciled the same as a v5 doc's.
  migrated.connectors = reconcileConnectors(migrated)
  // Reconcile groups (v6): validate, prune dangling boardIds, keep named-empty groups.
  // Runs post-migrate so a v5 doc's freshly-backfilled `[]` is handled like a v6 doc's.
  migrated.groups = reconcileGroups(migrated)
  // A corrupt camera shouldn't fail the whole load — drop to fit-on-load.
  if (!isValidViewport(migrated.viewport)) migrated.viewport = null
  return migrated
}

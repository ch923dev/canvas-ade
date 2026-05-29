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

/** Bump on any breaking change to the persisted shape and add a migration below. */
export const SCHEMA_VERSION = 1

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
}

export interface BrowserBoard extends BoardCommon {
  type: 'browser'
  url: string
  viewport: BrowserViewport
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

export type PlanningElement =
  | NoteElement
  | TextElement
  | ArrowElement
  | StrokeElement
  | ChecklistElement

export interface PlanningBoard extends BoardCommon {
  type: 'planning'
  elements: PlanningElement[]
}

export type Board = TerminalBoard | BrowserBoard | PlanningBoard

/** The whole-canvas serialized document (root of `canvas.json` in Phase 3). */
export interface CanvasDoc {
  schemaVersion: number
  boards: Board[]
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

/** Boards → a versioned document. Deep-clones so the doc owns its data. */
export function toObject(boards: Board[]): CanvasDoc {
  return { schemaVersion: SCHEMA_VERSION, boards: structuredClone(boards) }
}

type Migration = (doc: CanvasDoc) => CanvasDoc

/** Keyed by the FROM version. Empty at v1 — add entries as the shape evolves. */
const MIGRATIONS: Record<number, Migration> = {}

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

/** Parse + migrate an unknown value into a current-version document. */
export function fromObject(doc: unknown): CanvasDoc {
  if (!isCanvasDoc(doc)) {
    throw new Error('fromObject: value is not a CanvasDoc (need numeric schemaVersion + boards[])')
  }
  return migrate(doc)
}

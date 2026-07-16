/**
 * Coarse, agent-facing board status buckets (T1.1) — the single source of truth the
 * MCP `canvas://boards` / `canvas://board/{id}/status` resources expose AND the
 * on-canvas status pill (T1.6) reads. Derived in the renderer from the live runtime
 * stores (`terminalRuntimeStore` running-by-id + `previewStore` load state), then
 * pushed to MAIN over the board mirror — so the human-visible pill and the agent's
 * view can never disagree.
 *
 * Coverage v1 is intentionally coarse: terminals distinguish running vs idle only
 * (the runtime store tracks a single `running` boolean), browsers map their preview
 * load state, planning is static. The richer terminal states (`awaiting-review`,
 * `blocked`) are reserved here but only START being emitted in T1.3 (attention) and
 * M8 (permission detection), when MAIN gains the signals to detect them.
 */
import type { PreviewStatus } from './previewStore'
import type { AttentionKind } from './attentionStore'
import type { BoardStatus } from '../canvas/BoardFrame'

/** The coarse status buckets an agent (and the canvas chrome) sees per board. */
export type BoardStatusBucket =
  | 'idle'
  | 'running'
  | 'awaiting-review'
  | 'blocked'
  | 'failed'
  | 'static'

/** Live runtime signals a board's bucket is derived from (all optional → resting). */
export interface BoardStatusSignals {
  /** From `terminalRuntimeStore.running[id]` — a terminal's PTY is live. */
  terminalRunning?: boolean
  /** From `previewStore.byId[id].status` — a browser's load lifecycle. */
  preview?: PreviewStatus
  /** From `attentionStore.byId[id]` — an unseen agent-lifecycle event (desktop-notifications P2). */
  attention?: AttentionKind
}

/**
 * Map a board `type` + its live signals to a coarse bucket. An unrecognized
 * (forward) board type is treated as `static` — it has no known liveness signal.
 */
export function boardStatusBucket(type: string, signals: BoardStatusSignals): BoardStatusBucket {
  // Desktop-notifications P2: an unseen "find me" attention state outranks the liveness-derived
  // bucket — a Claude Notification fires while the PTY is still `running`, and the whole point is
  // that the board reads warn/err until the user looks at it. `done`-unseen keeps the normal
  // derivation (DESIGN.md gives it a badge, not a bucket change). This is what activates the
  // reserved `awaiting-review` bucket (T1.3) and feeds the MAIN status differ → `canvas://attention`.
  if (signals.attention === 'needs-input') return 'awaiting-review'
  if (signals.attention === 'error') return 'failed'
  switch (type) {
    case 'terminal':
      return signals.terminalRunning ? 'running' : 'idle'
    case 'browser':
      switch (signals.preview) {
        case 'connecting':
          return 'running'
        case 'load-failed':
        case 'crashed': // D2-C: a dead preview renderer is a failure the agent should see
          return 'failed'
        case 'connected':
        case 'idle':
        default:
          return 'idle'
      }
    case 'planning':
    case 'kanban':
      // Passive content boards — no liveness signal, so no pill (v17 kanban joins planning here;
      // the `default` would already bucket it static, but the explicit case documents the intent).
      return 'static'
    default:
      return 'static'
  }
}

/**
 * Map a coarse bucket to the on-canvas status pill (T1.6 — colour-token dot + a short
 * mono label). The SAME `boardStatusBucket` value drives both this pill AND the MCP
 * `canvas://boards` / `board-states` resources, so the human-visible dot and the
 * agent's view can never disagree (the one-source-of-truth rule). `static` boards
 * (planning / forward types) have no liveness → no pill. `running` uses `--ok` so the
 * BoardFrame pulse lights; attention buckets use `--warn`/`--err`.
 */
const BUCKET_PILL: Record<BoardStatusBucket, BoardStatus | null> = {
  running: { dot: 'var(--ok)', label: 'running' },
  idle: { dot: 'var(--text-3)', label: 'idle' },
  'awaiting-review': { dot: 'var(--warn)', label: 'awaiting review' },
  blocked: { dot: 'var(--warn)', label: 'blocked' },
  failed: { dot: 'var(--err)', label: 'failed' },
  static: null
}

/** The on-canvas status pill for a bucket (null = no pill, e.g. static boards). */
export function bucketToPill(bucket: BoardStatusBucket): BoardStatus | null {
  return BUCKET_PILL[bucket]
}

/** Per-board runtime the snapshot builder reads (the slices the mirror needs). */
export interface BoardStatusRuntime {
  running: Record<string, boolean>
  preview: Record<string, { status: PreviewStatus }>
  /** Unseen agent-attention per board (desktop-notifications P2). Optional so pre-existing
   *  callers/tests without the slice snapshot byte-identical to before. */
  attention?: Record<string, AttentionKind>
}

/**
 * A single agent-readable file reference (file-tree S5). A file board's `path` and each Planning
 * `fileref` element project to this shape on the board mirror so the MCP `canvas://boards` view can
 * point an agent at the files the human has surfaced. `path` is the project-relative POSIX path (the
 * `openFileBoard`/`file:*` contract); never file CONTENT.
 */
export interface FileRefSummary {
  path: string
  label: string
}

/**
 * One column in a Kanban board's mirror projection (P3b) — mirrors `KanbanColumn` (id/title + optional
 * WIP), so the host can serve it grouped as `canvas://board/{id}/cards`. Trusted-user text only.
 */
export interface KanbanColumnSummary {
  id: string
  title: string
  wip?: number
}

/**
 * One card in a Kanban board's mirror projection (P3b) — mirrors `KanbanCard` (flat, bound to a column
 * by `columnId`, with optional chips), so the host can group cards under their column on read. Card
 * TEXT the human already sees on-canvas; never file content / PTY bytes.
 */
export interface KanbanCardSummary {
  id: string
  columnId: string
  title: string
  tag?: string
  assignee?: string
  ref?: string
  /** v19 card-detail: long-form description (the host TRUNCATES it to a preview on ingest). */
  description?: string
  /** v19 card-detail: label chips (the plural that supersedes `tag`). */
  tags?: string[]
  /** v19 card-detail: file+line references the card touches. */
  fileRefs?: KanbanCardFileRefSummary[]
  /** #346: attachments the card carries (blob refs + metadata). Absent until a card has any. */
  attachments?: KanbanAttachmentSummary[]
}

/** One file+line ref on a card's mirror projection (v19) — path + optional 1-based line/endLine range. */
export interface KanbanCardFileRefSummary {
  path: string
  line?: number
  endLine?: number
}

/** One attachment on a card's mirror projection (#346) — a blob REF (assetId) + display metadata, no blob. */
export interface KanbanAttachmentSummary {
  assetId: string
  name: string
  kind: string
  mime?: string
  size?: number
}

/** One checklist item in a Planning board's mirror projection (S6) — id + label + done. */
export interface PlanningItemSummary {
  id: string
  label: string
  done: boolean
}

/**
 * One element in a Planning board's mirror projection (S6) — always its `id` + `kind`, plus the editable
 * fields that apply to that kind (text/tint for a note, title/items for a checklist, source for a
 * diagram). So the host can serve one board's elements as `canvas://board/{id}/planning`, letting an agent
 * EDIT an element in place by id instead of re-appending a duplicate. Element TEXT the human already sees.
 */
export interface PlanningElementSummary {
  id: string
  kind: string
  text?: string
  tint?: string
  title?: string
  source?: string
  items?: PlanningItemSummary[]
}

/** A board's metadata projection the mirror carries (control plane; no content). */
export interface BoardMirrorEntry {
  id: string
  type: string
  title: string
  /**
   * Terminal agent-preset id (schema v10 `agentKind`) — forwarded to the MCP
   * `canvas://boards` view so an orchestrator can route by capability. Absent on
   * non-terminal boards. The full `Board` objects passed in already carry it.
   */
  agentKind?: string
  /**
   * Terminal activity-monitoring opt-out (schema v10). Absent ⇒ monitored; `false`
   * keeps a plain shell out of the agent-facing attention queue (Phase B).
   */
  monitorActivity?: boolean
  /**
   * File board's project-relative path (file-tree S5; `type:'file'` only) — forwarded to
   * `canvas://boards` so an agent knows WHICH file an open File board points at. Absent on
   * non-file boards and on an unbound (placeholder) File board.
   */
  path?: string
  /**
   * Planning board's referenced files (file-tree S5; `type:'planning'` only) — the project-
   * relative path + display label of each `fileref` element, so an agent can see the files a human
   * pinned to a plan. Absent (not `[]`) when a planning board has no fileref elements, keeping
   * non-fileref snapshots byte-identical to before.
   */
  fileRefs?: FileRefSummary[]
  /**
   * World-space board geometry (P1 canvas awareness) — top-left `x`/`y` + size `w`/`h` in canvas
   * world px, forwarded to `canvas://boards` so an agent can reason about the SPATIAL layout (where
   * boards sit, how big, whether they overlap) and drive an informed tidy — not just the logical
   * id/type/status. Ride out only when present, so a geometry-less test stub stays byte-identical.
   */
  x?: number
  y?: number
  w?: number
  h?: number
  /**
   * Kanban board's bounded columns + cards (P3b; `type:'kanban'` only) — the ordered lanes + flat
   * cards, so the host can serve one board's plan as `canvas://board/{id}/cards` (grouped host-side).
   * A BOUNDED projection (count-capped here, field-capped on the host ingest), NOT the raw arrays.
   * Absent (not empty) on every non-kanban board, keeping their snapshots byte-identical.
   */
  kanban?: {
    columns: KanbanColumnSummary[]
    cards: KanbanCardSummary[]
    /** v19: what the columns group by; absent ⇒ 'flow'. */
    columnAxis?: 'flow' | 'category'
    /** v19: display name of the column axis. */
    axisLabel?: string
  }
  /**
   * Planning board's bounded elements + their ids (S6; `type:'planning'` only) — so the host serves one
   * board's elements as `canvas://board/{id}/planning` (the read half of the in-place edit loop). A
   * BOUNDED projection (count-capped here, field-capped on the host ingest), NOT the raw elements. Absent
   * (not empty) on every non-planning board, keeping their snapshots byte-identical.
   */
  planning?: { elements: PlanningElementSummary[] }
}

/**
 * The minimal board shape {@link buildBoardSnapshot} READS. A superset of the mirror's inputs: a
 * `'file'` board's `path` and a `'planning'` board's `elements` (the latter read only to derive
 * `fileRefs`, NEVER emitted onto the mirror). The live `Board` union satisfies this structurally;
 * tests pass plain objects.
 */
export interface BoardSnapshotInput {
  id: string
  type: string
  title: string
  agentKind?: string
  monitorActivity?: boolean
  /** Present on a `'file'` board (FileBoard.path). */
  path?: string
  /** Present on a `'planning'` board (PlanningBoard.elements); read to derive `fileRefs` (S5) AND the
   *  bounded `planning` element projection (S6). A structural superset of the live `PlanningElement`
   *  union's mirrored fields; the live boards satisfy it, and a test stub sets only what it needs. */
  elements?: ReadonlyArray<{
    id?: string
    kind: string
    path?: string
    label?: string
    text?: string
    tint?: string
    title?: string
    source?: string
    items?: ReadonlyArray<{ id?: string; label?: string; done?: boolean }>
  }>
  /** World-space geometry (P1) — every real `Board` carries these via `BoardCommon`; optional here
   *  so a minimal test stub still satisfies the read shape. Forwarded to the mirror when finite. */
  x?: number
  y?: number
  w?: number
  h?: number
  /** Present on a `'kanban'` board (KanbanBoard.columns); read to project the bounded kanban summary. */
  columns?: ReadonlyArray<{ id: string; title: string; wip?: number }>
  /** Present on a `'kanban'` board (KanbanBoard.cards); read to project the bounded kanban summary. */
  cards?: ReadonlyArray<{
    id: string
    columnId: string
    title: string
    tag?: string
    assignee?: string
    ref?: string
    /** v19 card-detail (KanbanCard.description/tags/fileRefs) — projected onto the mirror; host caps. */
    description?: string
    tags?: ReadonlyArray<string>
    fileRefs?: ReadonlyArray<{ path: string; line?: number; endLine?: number }>
    /** #346 (KanbanCard.attachments) — file blob refs OR external links; projected read-only, host
     *  validates/caps. A link carries `url` (no `assetId`); a file kind carries `assetId` — mirrors
     *  the KanbanAttachment union so the live board satisfies this read shape. */
    attachments?: ReadonlyArray<{
      assetId?: string
      url?: string
      name: string
      kind: string
      mime?: string
      size?: number
    }>
  }>
  /** Present on a `'kanban'` board (v19 KanbanBoard.columnAxis/axisLabel) — the column-axis + its name. */
  columnAxis?: 'flow' | 'category'
  axisLabel?: string
}

/**
 * Derive a planning board's agent-readable file references from its elements (S5). Keeps only
 * well-formed `fileref` elements with a non-empty string `path`; `label` falls back to the path's
 * basename, then the path itself, so a missing label never blanks the reference. Returns `undefined`
 * (not `[]`) when there are none, so the conditional spread in {@link buildBoardSnapshot} omits the
 * field for fileref-free planning boards.
 */
function deriveFileRefs(
  elements: ReadonlyArray<{ kind: string; path?: string; label?: string }> | undefined
): FileRefSummary[] | undefined {
  if (!elements) return undefined
  const refs: FileRefSummary[] = []
  for (const el of elements) {
    if (el.kind !== 'fileref') continue
    const path = el.path
    if (typeof path !== 'string' || path.length === 0) continue
    const label =
      typeof el.label === 'string' && el.label.length > 0
        ? el.label
        : (path.split('/').pop() ?? '') || path
    refs.push({ path, label })
  }
  return refs.length > 0 ? refs : undefined
}

/**
 * Bound the mirrored kanban projection so a pathological board can't push an unbounded payload over
 * the `mcp:boards` IPC channel (the host re-caps authoritatively on ingest). Counts only — the field
 * lengths are the host's trust-boundary job (mirrors the `deriveFileRefs` → host `sanitizeFileRefs`
 * split, where the renderer projects and the host caps).
 */
const MAX_KANBAN_COLUMNS = 50
const MAX_KANBAN_CARDS = 300

/**
 * Project a kanban board's `columns`/`cards` into the bounded mirror summary (P3b). Keeps only
 * entries whose required ids/titles are non-empty strings, count-caps both lists, and carries the
 * optional chips/WIP through when present. Returns `undefined` (not an empty projection) when there
 * is nothing to project, so the conditional spread in {@link buildBoardSnapshot} omits the field.
 */
type KanbanSummary = NonNullable<BoardMirrorEntry['kanban']>

function deriveKanban(
  columns: BoardSnapshotInput['columns'],
  cards: BoardSnapshotInput['cards'],
  columnAxis: BoardSnapshotInput['columnAxis'],
  axisLabel: BoardSnapshotInput['axisLabel']
): KanbanSummary | undefined {
  const cols: KanbanColumnSummary[] = []
  if (columns) {
    for (const c of columns) {
      if (cols.length >= MAX_KANBAN_COLUMNS) break
      if (typeof c?.id !== 'string' || c.id.length === 0 || typeof c.title !== 'string') continue
      const col: KanbanColumnSummary = { id: c.id, title: c.title }
      if (typeof c.wip === 'number' && Number.isFinite(c.wip)) col.wip = c.wip
      cols.push(col)
    }
  }
  const out: KanbanCardSummary[] = []
  if (cards) {
    for (const c of cards) {
      if (out.length >= MAX_KANBAN_CARDS) break
      if (
        typeof c?.id !== 'string' ||
        c.id.length === 0 ||
        typeof c.columnId !== 'string' ||
        c.columnId.length === 0 ||
        typeof c.title !== 'string'
      ) {
        continue
      }
      const card: KanbanCardSummary = { id: c.id, columnId: c.columnId, title: c.title }
      if (typeof c.tag === 'string' && c.tag.length > 0) card.tag = c.tag
      if (typeof c.assignee === 'string' && c.assignee.length > 0) card.assignee = c.assignee
      if (typeof c.ref === 'string' && c.ref.length > 0) card.ref = c.ref
      // v19 card-detail: project description/tags/fileRefs; the host caps/truncates on ingest.
      if (typeof c.description === 'string' && c.description.length > 0) {
        card.description = c.description
      }
      if (Array.isArray(c.tags)) {
        const tags = c.tags.filter((t): t is string => typeof t === 'string' && t.length > 0)
        if (tags.length > 0) card.tags = tags
      }
      if (Array.isArray(c.fileRefs)) {
        const refs: KanbanCardFileRefSummary[] = []
        for (const r of c.fileRefs) {
          if (!r || typeof r.path !== 'string' || r.path.length === 0) continue
          const ref: KanbanCardFileRefSummary = { path: r.path }
          if (typeof r.line === 'number' && Number.isFinite(r.line)) ref.line = r.line
          if (typeof r.endLine === 'number' && Number.isFinite(r.endLine)) ref.endLine = r.endLine
          refs.push(ref)
        }
        if (refs.length > 0) card.fileRefs = refs
      }
      // #346 attachments: project the blob refs + metadata (read-only); the host validates/caps on ingest.
      // Only FILE attachments (with an `assetId`) are mirrored — LINK attachments (a `url`, no assetId)
      // are intentionally skipped here for now: the agent-read summary + the published mcp schema know
      // only blob refs, so exposing links to the agent is a deliberate future follow-up, not a bug.
      if (Array.isArray(c.attachments)) {
        const atts: KanbanAttachmentSummary[] = []
        for (const a of c.attachments) {
          if (!a || typeof a.assetId !== 'string' || a.assetId.length === 0) continue
          if (typeof a.name !== 'string' || typeof a.kind !== 'string') continue
          const att: KanbanAttachmentSummary = { assetId: a.assetId, name: a.name, kind: a.kind }
          if (typeof a.mime === 'string' && a.mime.length > 0) att.mime = a.mime
          if (typeof a.size === 'number' && Number.isFinite(a.size)) att.size = a.size
          atts.push(att)
        }
        if (atts.length > 0) card.attachments = atts
      }
      out.push(card)
    }
  }
  const label = typeof axisLabel === 'string' && axisLabel.length > 0 ? axisLabel : undefined
  const axis = columnAxis === 'flow' || columnAxis === 'category' ? columnAxis : undefined
  if (cols.length === 0 && out.length === 0 && axis === undefined && label === undefined) {
    return undefined
  }
  const result: KanbanSummary = { columns: cols, cards: out }
  if (axis !== undefined) result.columnAxis = axis
  if (label !== undefined) result.axisLabel = label
  return result
}

/** Cap the mirrored planning projection so a pathological board can't push an unbounded payload over the
 *  `mcp:boards` IPC channel (the host re-caps + field-truncates authoritatively on ingest). Counts only. */
const MAX_PLANNING_ELEMENTS = 300
const MAX_PLANNING_ITEMS = 100

/**
 * Project a planning board's `elements` into the bounded mirror summary (S6). Keeps every element that
 * has a string `id`+`kind`, count-caps elements + a checklist's items, and carries the editable fields
 * (text/tint for a note, title/items for a checklist, source for a diagram) through when present so the
 * host can serve `canvas://board/{id}/planning`. Returns `undefined` (not an empty projection) when there
 * is nothing to project, so the conditional spread in {@link buildBoardSnapshot} omits the field. Field
 * lengths are the host's trust-boundary job (mirrors the `deriveKanban` → host `sanitizeKanban` split).
 */
function derivePlanning(
  elements: BoardSnapshotInput['elements']
): { elements: PlanningElementSummary[] } | undefined {
  if (!elements) return undefined
  const out: PlanningElementSummary[] = []
  for (const e of elements) {
    if (out.length >= MAX_PLANNING_ELEMENTS) break
    if (typeof e?.id !== 'string' || e.id.length === 0 || typeof e.kind !== 'string') continue
    const el: PlanningElementSummary = { id: e.id, kind: e.kind }
    if (typeof e.text === 'string' && e.text.length > 0) el.text = e.text
    if (typeof e.tint === 'string' && e.tint.length > 0) el.tint = e.tint
    if (typeof e.title === 'string' && e.title.length > 0) el.title = e.title
    if (typeof e.source === 'string' && e.source.length > 0) el.source = e.source
    if (e.kind === 'checklist' && Array.isArray(e.items)) {
      const items: PlanningItemSummary[] = []
      for (const it of e.items) {
        if (items.length >= MAX_PLANNING_ITEMS) break
        if (typeof it?.id !== 'string' || it.id.length === 0) continue
        items.push({
          id: it.id,
          label: typeof it.label === 'string' ? it.label : '',
          done: it.done === true
        })
      }
      el.items = items
    }
    out.push(el)
  }
  return out.length > 0 ? { elements: out } : undefined
}

/**
 * Build the renderer→MAIN board snapshot: each board's `{id,type,title}` plus its
 * derived `status` bucket. Pure — no store/React access — so it is unit-testable and
 * the publish hook is a thin wiring layer over it. The v10 agent-identity fields and the
 * S5 file-context fields (`path` / `fileRefs`) ride through only when present, so a board
 * without them snapshots byte-identical to before.
 */
export function buildBoardSnapshot(
  boards: ReadonlyArray<BoardSnapshotInput>,
  runtime: BoardStatusRuntime
): Array<BoardMirrorEntry & { status: BoardStatusBucket }> {
  return boards.map((b) => {
    // File-context projection (S5): a file board forwards its bound path; a planning board forwards
    // its fileref elements as path+label summaries. Both omitted (not empty) when absent.
    const path = b.type === 'file' && typeof b.path === 'string' ? b.path : undefined
    const fileRefs = b.type === 'planning' ? deriveFileRefs(b.elements) : undefined
    // S6: a planning board projects its bounded elements+ids so the host serves canvas://board/{id}/planning.
    const planning = b.type === 'planning' ? derivePlanning(b.elements) : undefined
    // P3b: a kanban board projects its bounded columns+cards so the host serves canvas://board/{id}/cards.
    const kanban =
      b.type === 'kanban' ? deriveKanban(b.columns, b.cards, b.columnAxis, b.axisLabel) : undefined
    return {
      id: b.id,
      type: b.type,
      title: b.title,
      status: boardStatusBucket(b.type, {
        terminalRunning: runtime.running[b.id],
        preview: runtime.preview[b.id]?.status,
        attention: runtime.attention?.[b.id]
      }),
      ...(b.agentKind !== undefined ? { agentKind: b.agentKind } : {}),
      ...(b.monitorActivity !== undefined ? { monitorActivity: b.monitorActivity } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(fileRefs !== undefined ? { fileRefs } : {}),
      // P1 canvas awareness: forward world-space geometry when finite (every real board carries it;
      // a Number.isFinite guard keeps a geometry-less test stub byte-identical + drops any NaN/∞).
      ...(Number.isFinite(b.x) ? { x: b.x } : {}),
      ...(Number.isFinite(b.y) ? { y: b.y } : {}),
      ...(Number.isFinite(b.w) ? { w: b.w } : {}),
      ...(Number.isFinite(b.h) ? { h: b.h } : {}),
      // P3b: kanban lanes+cards ride out only for kanban boards (omitted ⇒ byte-identical elsewhere).
      ...(kanban !== undefined ? { kanban } : {}),
      // S6: planning elements+ids ride out only for planning boards (omitted ⇒ byte-identical elsewhere).
      ...(planning !== undefined ? { planning } : {})
    }
  })
}

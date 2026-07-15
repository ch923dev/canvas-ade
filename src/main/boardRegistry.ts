import type { IpcMain, BrowserWindow, IpcMainEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/** Minimal board projection the renderer pushes to MAIN (control plane; no content). */
export interface BoardMirror {
  id: string
  type: string
  title: string
  /**
   * Coarse status bucket derived by the renderer from the live runtime stores
   * (T1.1). Absent when the renderer predates T1.1 (the adapter then falls back to
   * a PTY/presence-derived bucket). Validated against {@link STATUS_BUCKETS}.
   */
  status?: string
  /**
   * Terminal agent-preset id the human chose (schema v10 `agentKind`) — `'claude'`,
   * `'codex'`, … — so an orchestrator can route by capability. Open string, length-capped
   * like the other fields; absent on non-terminal boards and pre-v10 terminals.
   */
  agentKind?: string
  /**
   * Whether this terminal participates in activity monitoring (schema v10). Absent ⇒
   * monitored (opt-out, not opt-in). `false` keeps a plain shell out of the agent-facing
   * `canvas://attention` queue + its notifier (Phase B). Coerced to a strict boolean.
   */
  monitorActivity?: boolean
  /**
   * File board's project-relative path (file-tree S5; `type:'file'` only) — forwarded to the
   * agent-facing `canvas://boards` view so an agent knows WHICH file an open File board points
   * at. Length-capped like the other fields; absent on non-file / unbound boards. Path only,
   * never file CONTENT.
   */
  path?: string
  /**
   * Planning board's referenced files (file-tree S5; `type:'planning'` only) — the path + label
   * of each `fileref` element, so an agent can see the files a human pinned to a plan. Bounded
   * ({@link MAX_FILEREFS}) and length-capped per entry. Absent when none.
   */
  fileRefs?: FileRefMirror[]
  /**
   * World-space board geometry (P1 canvas awareness) — top-left `x`/`y` + size `w`/`h` in canvas
   * world px, forwarded to `canvas://boards` (and the app self-model) so an agent can reason about
   * the SPATIAL layout and drive an informed tidy. Validated as FINITE numbers on ingest
   * ({@link sanitizeSnapshot}) — `mcp:boards` is an IPC channel, so a non-finite/non-number value
   * drops the field (keeps the board). Absent on a renderer predating P1.
   */
  x?: number
  y?: number
  w?: number
  h?: number
  /**
   * Kanban board's bounded columns + cards (P3b; `type:'kanban'` only) — validated + capped on ingest
   * ({@link sanitizeKanban}) since `mcp:boards` is an IPC channel, then served GROUPED (cards nested
   * under their column) as the per-board `canvas://board/{id}/cards` read resource. Card TEXT the human
   * already sees on-canvas — never file content / PTY bytes. Absent on every non-kanban board.
   */
  kanban?: KanbanMirror
  /**
   * Planning board's bounded elements + their ids (S6; `type:'planning'` only) — validated + capped on
   * ingest ({@link sanitizePlanning}) since `mcp:boards` is an IPC channel, then served as the per-board
   * `canvas://board/{id}/planning` read resource so an agent can EDIT an element in place (by id) instead
   * of re-appending a duplicate. Element TEXT the human already sees on-canvas — never PTY bytes. Absent
   * on every non-planning board.
   */
  planning?: PlanningMirror
}

/** A single agent-readable file reference on the board mirror (file-tree S5). Path only, no content. */
export interface FileRefMirror {
  path: string
  label: string
}

/** One column (lane) in a Kanban board's mirror projection (P3b) — id/title + optional WIP limit. */
export interface KanbanColumnMirror {
  id: string
  title: string
  wip?: number
}

/** One file+line ref on a Kanban card's mirror projection (v19) — path + optional 1-based line/endLine. */
export interface KanbanCardFileRefMirror {
  path: string
  line?: number
  endLine?: number
}

/** One attachment on a Kanban card's mirror projection (#346) — a blob REF (assetId) + display metadata. */
export interface KanbanAttachmentMirror {
  assetId: string
  name: string
  kind: string
  mime?: string
  size?: number
}

/** One card in a Kanban board's mirror projection (P3b→v19→#346) — flat, bound to a column by `columnId`. */
export interface KanbanCardMirror {
  id: string
  columnId: string
  title: string
  tag?: string
  assignee?: string
  ref?: string
  /** v19 card-detail: long-form description, TRUNCATED to a preview on ingest (identification, not fidelity). */
  description?: string
  /** v19 card-detail: label chips (the plural that supersedes `tag`). */
  tags?: string[]
  /** v19 card-detail: file+line references the card touches. */
  fileRefs?: KanbanCardFileRefMirror[]
  /** #346 attachments: blob refs (assetId + metadata) the card carries; read-only. Absent until a card has any. */
  attachments?: KanbanAttachmentMirror[]
}

/**
 * A Kanban board's bounded columns + cards on the mirror (P3b→v19). The host groups it on read. v19 adds
 * the board's optional COLUMN AXIS (what the lanes group by) + its display name.
 */
export interface KanbanMirror {
  columns: KanbanColumnMirror[]
  cards: KanbanCardMirror[]
  /** v19: 'flow' (workflow stages) | 'category' (buckets); absent ⇒ 'flow' at read. */
  columnAxis?: 'flow' | 'category'
  /** v19: display name of the column axis (e.g. "Phase"/"Subsystem"). */
  axisLabel?: string
}

/** One checklist item in a Planning board's mirror projection (S6) — id + label + done. */
export interface PlanningItemMirror {
  id: string
  label: string
  done: boolean
}

/**
 * One element in a Planning board's mirror projection (S6) — always its `id` + `kind`, plus the
 * editable fields that apply to that kind (text/tint for a note, title/items for a checklist, source
 * for a diagram, …). Long free-text is TRUNCATED to a preview on ingest (identification, not fidelity —
 * an `update_planning_element` supplies full new content). Served as `canvas://board/{id}/planning`.
 */
export interface PlanningElementMirror {
  id: string
  kind: string
  text?: string
  tint?: string
  title?: string
  source?: string
  items?: PlanningItemMirror[]
}

/** A Planning board's bounded elements on the mirror (S6). The host serves it as the read resource. */
export interface PlanningMirror {
  elements: PlanningElementMirror[]
}

/**
 * A board↔board connector the renderer mirrors to MAIN (M2). Only `orchestration` edges
 * authorize dispatch (T4.6 relay_prompt); `preview` edges are the Browser→Terminal link.
 * Directional: `sourceId → targetId`. Mirror of `Connector` in `renderer/.../boardSchema.ts`.
 */
export interface ConnectorMirror {
  id: string
  sourceId: string
  targetId: string
  kind: 'preview' | 'orchestration'
}

/** Connector kinds a renderer may publish; an unrecognized kind is dropped. */
const CONNECTOR_KINDS: ReadonlySet<string> = new Set(['preview', 'orchestration'])

/**
 * A Named Board Group the renderer mirrors to MAIN (PR-5). A group is a user-named set of
 * boards (a "feature zone") — a board may belong to many groups; named-empty groups survive.
 * Mirror of `NamedGroup` in `renderer/.../boardSchema.ts`. Read-only on MAIN: the app-model's
 * `canvas.groups` projects this so the orchestrator/agent can reason about feature zones.
 */
export interface GroupMirror {
  id: string
  name: string
  boardIds: string[]
}

/**
 * The buckets a renderer is allowed to publish (mirror of `BoardStatusBucket` in
 * `renderer/src/store/boardStatus.ts`). `status` arrives over an IPC channel, so an
 * unrecognized value is dropped — never forwarded to agents as-is.
 */
const STATUS_BUCKETS: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'awaiting-review',
  'blocked',
  'failed',
  'static'
])

/** A coarse per-board status change (M5). `status` is a STATUS_BUCKETS value, or 'gone'. */
export interface BoardStatusChange {
  id: string
  status: string
  /**
   * Mirror of {@link BoardMirror.monitorActivity} at the time of the change (Phase B). The
   * MCP attention notifier gates its push on `monitorActivity !== false`; carrying it on the
   * change lets the notifier decide membership without a second board lookup. Omitted on a
   * `'gone'` change (the board is leaving — its flag no longer matters).
   */
  monitorActivity?: boolean
}

/**
 * Pure differ: the per-board status changes between two snapshots (M5 event-driven attention).
 * Emits a change for any board whose known bucket changed or first appeared WITH a bucket, and a
 * `{ status: 'gone' }` for any id present before and now absent. A board newly appearing WITHOUT a
 * bucket is skipped (the renderer always buckets now; the bucketless fallback is legacy).
 * Inputs are sanitized mirrors (`sanitizeSnapshot` already dropped unknown buckets), so this does
 * no bucket re-validation — it just diffs.
 *
 * Phase B: also emits when only `monitorActivity` flipped (status unchanged) — so a mid-session
 * monitor opt-out/opt-in still drives the attention notifier's leave/enter — and carries the
 * current `monitorActivity` on every (non-`gone`) change.
 */
export function diffStatus(prev: BoardMirror[], next: BoardMirror[]): BoardStatusChange[] {
  const prevById = new Map(prev.map((b) => [b.id, b]))
  const nextIds = new Set(next.map((b) => b.id))
  const changes: BoardStatusChange[] = []
  for (const b of next) {
    if (b.status === undefined) continue
    const before = prevById.get(b.id)
    const statusChanged = b.status !== before?.status
    const monitorChanged = b.monitorActivity !== before?.monitorActivity
    if (statusChanged || monitorChanged) {
      changes.push({ id: b.id, status: b.status, monitorActivity: b.monitorActivity })
    }
  }
  for (const b of prev) {
    if (!nextIds.has(b.id)) changes.push({ id: b.id, status: 'gone' })
  }
  return changes
}

let mirror: BoardMirror[] = []
let connectorMirror: ConnectorMirror[] = []
let groupMirror: GroupMirror[] = []

/** Listeners notified on each per-board status change (M5 event-driven attention). */
const statusListeners = new Set<(change: BoardStatusChange) => void>()

/** Listeners notified after EVERY applied snapshot (cross-project routing, 2026-07-09): the
 *  pending-command drainer wakes on these — a publish is proof the renderer store settled. */
const snapshotListeners = new Set<() => void>()

function emitStatus(change: BoardStatusChange): void {
  for (const cb of statusListeners) {
    try {
      cb(change)
    } catch {
      // 🔒 Isolate a throwing listener so one bad subscriber can't break the push fan-out.
    }
  }
}

/** Replace the stored snapshot and emit the per-board status diffs (M5). Groups (PR-5) are
 *  metadata-only — stored, never diffed (no status transition rides on group membership). */
function applySnapshot(
  nextBoards: BoardMirror[],
  nextConnectors: ConnectorMirror[],
  nextGroups: GroupMirror[] = []
): void {
  const changes = diffStatus(mirror, nextBoards)
  mirror = nextBoards
  connectorMirror = nextConnectors
  groupMirror = nextGroups
  for (const c of changes) emitStatus(c)
  for (const cb of snapshotListeners) {
    try {
      cb()
    } catch {
      // 🔒 Isolate a throwing listener so one bad subscriber can't break the push fan-out.
    }
  }
}

/**
 * Subscribe to applied snapshots (cross-project routing). Fires AFTER the mirror is replaced and
 * the status diffs are emitted, once per renderer publish. Returns an unsubscribe fn.
 */
export function subscribeBoardSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener)
  return () => {
    snapshotListeners.delete(listener)
  }
}

/**
 * Subscribe to per-board status changes (M5). Returns an unsubscribe fn. The MCP adapter forwards
 * these so the handoff await-idle (and, in PR2, the barriers + canvas://attention notifier) wakes
 * on real board state instead of polling.
 * Note: a `'gone'` change is emitted for ANY board that left the canvas, including one that never
 * carried a known status bucket — treat `'gone'` as a presence signal, not a bucket transition.
 */
export function subscribeBoardStatus(listener: (change: BoardStatusChange) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Test seam — apply a snapshot through the diff/emit path (unit tests only). */
export function __applySnapshotForTest(
  boards: BoardMirror[],
  connectors: ConnectorMirror[] = [],
  groups: GroupMirror[] = []
): void {
  applySnapshot(boards, connectors, groups)
}

/** Test seam — clear all status listeners between tests (unit tests only). */
export function __clearStatusListenersForTest(): void {
  statusListeners.clear()
}

/** Test seam — clear all snapshot listeners between tests (unit tests only). */
export function __clearSnapshotListenersForTest(): void {
  snapshotListeners.clear()
}

/** Bound the snapshot so a forged/oversized push on mcp:boards can't grow MAIN memory. */
const MAX_BOARDS = 500
const MAX_CONNECTORS = 1000
const MAX_GROUPS = 200
/** Cap a single group's membership so one forged group can't grow MAIN memory unbounded. */
const MAX_GROUP_MEMBERS = 500
/** Cap a single planning board's mirrored file references (file-tree S5) so a forged push can't grow MAIN memory. */
const MAX_FILEREFS = 500
/** Cap a single kanban board's mirrored lanes + cards (P3b) so a forged push can't grow MAIN memory. */
const MAX_KANBAN_COLUMNS = 50
const MAX_KANBAN_CARDS = 300
/** Cap a single card's mirrored v19 detail lists (tags / fileRefs / attachments) so a forged push can't grow memory. */
const MAX_KANBAN_CARD_TAGS = 20
const MAX_KANBAN_CARD_FILE_REFS = 50
const MAX_KANBAN_CARD_ATTACHMENTS = 50
const MAX_FIELD_LEN = 256
/** A card fileRef `path` mirrors with a GENEROUS cap (a real, HUMAN-authored project-relative path can
 *  exceed the 256 chip cap; dropping it would make the ref vanish from `canvas://board/{id}/cards` even
 *  though the human sees it in the UI). Agent-written paths stay bounded at 256 by the write gate
 *  (`mcpKanban.ts`), which is ≤ this, so an agent-accepted path always survives read-back. */
const MAX_KANBAN_FILE_REF_PATH = 1024
/** A kanban card's description mirrors at FULL fidelity (up to the host write cap `mcpKanban.ts`
 *  MAX_CARD_DESCRIPTION = 4000), NOT the 500-char planning preview: `canvas://board/{id}/cards` is the
 *  agent's read-before-write source, so a &gt;500-char description an agent wrote must read back whole or the
 *  mandated read→update loop silently loses the tail. Still bounded (truncate, not drop) as a memory cap. */
const MAX_KANBAN_CARD_DESCRIPTION = 4000
/** The attachment `kind` values #346 mints (a card-store enum); an off-value is dropped on ingest. */
const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'file'])
/** Cap a single planning board's mirrored elements + items (S6) so a forged push can't grow MAIN memory. */
const MAX_PLANNING_ELEMENTS = 300
const MAX_PLANNING_ITEMS = 100
/** Free-text preview length for a mirrored note/text/diagram/label (S6) — long content is TRUNCATED (not
 *  dropped) so the element stays addressable by id for an edit; the edit itself supplies full content. */
const MAX_PLANNING_PREVIEW = 500

/**
 * Keep only well-formed {path,label} file references; drop anything else (file-tree S5). Bounded
 * like the other snapshot fields — mcp:boards is an IPC channel — at most MAX_FILEREFS entries,
 * each `path`/`label` at most MAX_FIELD_LEN chars (over-length / non-string entry dropped). Returns
 * `undefined` (not `[]`) when the input is not a non-empty array of valid refs, so the entry omits
 * the field rather than carrying an empty array.
 */
function sanitizeFileRefs(input: unknown): FileRefMirror[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: FileRefMirror[] = []
  for (const r of input) {
    if (out.length >= MAX_FILEREFS) break
    if (
      r &&
      typeof r === 'object' &&
      typeof (r as FileRefMirror).path === 'string' &&
      typeof (r as FileRefMirror).label === 'string'
    ) {
      const { path, label } = r as FileRefMirror
      if (path.length === 0 || path.length > MAX_FIELD_LEN || label.length > MAX_FIELD_LEN) continue
      out.push({ path, label })
    }
  }
  return out.length > 0 ? out : undefined
}

/** A non-empty, length-capped string, or undefined (a bad/over-length/empty value drops the field).
 *  `max` defaults to {@link MAX_FIELD_LEN}; a path field passes a larger cap (a real file path can be
 *  longer than a chip). Over-length DROPS (never truncates) — a truncated path is a wrong reference. */
function boundedStr(v: unknown, max: number = MAX_FIELD_LEN): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return undefined
  return v
}

/** A non-empty free-text value, TRUNCATED to `max` — unlike {@link boundedStr} an over-length value is
 *  cut, not dropped, so long content stays identifiable/usable rather than vanishing. */
function boundedText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined
  return v.length > max ? v.slice(0, max) : v
}

/** A note/text/diagram/label PREVIEW, TRUNCATED to {@link MAX_PLANNING_PREVIEW} (S6) — identification,
 *  not fidelity (the edit itself supplies full content). */
function boundedPreview(v: unknown): string | undefined {
  return boundedText(v, MAX_PLANNING_PREVIEW)
}

/**
 * Keep only well-formed Planning elements + their ids (S6). Bounded like the other snapshot fields —
 * `mcp:boards` is an IPC channel — cap elements ({@link MAX_PLANNING_ELEMENTS}) + checklist items
 * ({@link MAX_PLANNING_ITEMS}); every element keeps its `id`+`kind`, and the editable free-text fields are
 * truncated to a preview ({@link boundedPreview}). An element missing a required id/kind is dropped.
 * Returns `undefined` (not an empty projection) when nothing survives, so {@link sanitizeSnapshot} omits
 * the field. The host serves the survivors as `canvas://board/{id}/planning` (read half of the edit loop).
 */
function sanitizePlanning(input: unknown): PlanningMirror | undefined {
  if (!input || typeof input !== 'object') return undefined
  const { elements } = input as { elements?: unknown }
  if (!Array.isArray(elements)) return undefined
  const out: PlanningElementMirror[] = []
  for (const e of elements) {
    if (out.length >= MAX_PLANNING_ELEMENTS) break
    if (!e || typeof e !== 'object') continue
    const rec = e as Record<string, unknown>
    const id = boundedStr(rec.id)
    const kind = boundedStr(rec.kind)
    if (id === undefined || kind === undefined) continue
    const el: PlanningElementMirror = { id, kind }
    const text = boundedPreview(rec.text)
    if (text !== undefined) el.text = text
    const tint = boundedStr(rec.tint)
    if (tint !== undefined) el.tint = tint
    const title = boundedPreview(rec.title)
    if (title !== undefined) el.title = title
    const source = boundedPreview(rec.source)
    if (source !== undefined) el.source = source
    if (kind === 'checklist' && Array.isArray(rec.items)) {
      const items: PlanningItemMirror[] = []
      for (const it of rec.items) {
        if (items.length >= MAX_PLANNING_ITEMS) break
        if (!it || typeof it !== 'object') continue
        const iid = boundedStr((it as Record<string, unknown>).id)
        if (iid === undefined) continue
        items.push({
          id: iid,
          label: boundedPreview((it as Record<string, unknown>).label) ?? '',
          done: (it as Record<string, unknown>).done === true
        })
      }
      el.items = items
    }
    out.push(el)
  }
  return out.length > 0 ? { elements: out } : undefined
}

/** Keep only well-formed card `tags` (v19) — non-empty length-capped strings, count-capped; else undefined. */
function sanitizeCardTags(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: string[] = []
  for (const t of input) {
    if (out.length >= MAX_KANBAN_CARD_TAGS) break
    const v = boundedStr(t)
    if (v !== undefined) out.push(v)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Keep only well-formed card `fileRefs` (v19) — each a `{path, line?, endLine?}` with a non-empty
 * length-capped `path` and finite positive `line`/`endLine`. Count-capped ({@link MAX_KANBAN_CARD_FILE_REFS});
 * a malformed entry is dropped. Returns `undefined` when nothing survives, so the card omits the field.
 */
function sanitizeCardFileRefs(input: unknown): KanbanCardFileRefMirror[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: KanbanCardFileRefMirror[] = []
  for (const r of input) {
    if (out.length >= MAX_KANBAN_CARD_FILE_REFS) break
    if (!r || typeof r !== 'object') continue
    const path = boundedStr((r as KanbanCardFileRefMirror).path, MAX_KANBAN_FILE_REF_PATH)
    if (path === undefined) continue
    const ref: KanbanCardFileRefMirror = { path }
    const { line, endLine } = r as KanbanCardFileRefMirror
    // Coupled + integer, matching the write gate (`mcpKanban.ts` sanitizeCardFileRefs) and the human
    // path (`kanbanEdit.ts` normLine): `line` is a positive INTEGER; `endLine` is kept ONLY when a
    // `line` is present AND it is a real range (endLine > line). A fractional line, a bare endLine, or
    // endLine ≤ line (shapes no legitimate producer emits — only a hand-edited/adversarial doc) is dropped.
    if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
      ref.line = line
      if (typeof endLine === 'number' && Number.isInteger(endLine) && endLine > line) {
        ref.endLine = endLine
      }
    }
    out.push(ref)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Keep only well-formed card `attachments` (#346) — each a `{assetId, name, kind, mime?, size?}` blob
 * ref. `assetId`/`name` are non-empty length-capped strings; `kind` is a known {@link ATTACHMENT_KINDS}
 * value; `mime` a length-capped string; `size` a finite positive number. Count-capped; a malformed entry
 * is dropped. Returns `undefined` when nothing survives, so the card omits the field. NEVER the blob —
 * only the logical ref + display metadata (ADR 0009: the card carries the assetId, not the bytes).
 */
function sanitizeCardAttachments(input: unknown): KanbanAttachmentMirror[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: KanbanAttachmentMirror[] = []
  for (const a of input) {
    if (out.length >= MAX_KANBAN_CARD_ATTACHMENTS) break
    if (!a || typeof a !== 'object') continue
    const rec = a as Record<string, unknown>
    const assetId = boundedStr(rec.assetId)
    const name = boundedStr(rec.name)
    if (assetId === undefined || name === undefined) continue
    if (typeof rec.kind !== 'string' || !ATTACHMENT_KINDS.has(rec.kind)) continue
    const att: KanbanAttachmentMirror = { assetId, name, kind: rec.kind }
    const mime = boundedStr(rec.mime)
    if (mime !== undefined) att.mime = mime
    if (typeof rec.size === 'number' && Number.isFinite(rec.size) && rec.size > 0)
      att.size = rec.size
    out.push(att)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Keep only well-formed Kanban lanes + cards; drop anything else (P3b). Bounded like the other
 * snapshot fields — `mcp:boards` is an IPC channel, so trust nothing: cap columns
 * ({@link MAX_KANBAN_COLUMNS}) + cards ({@link MAX_KANBAN_CARDS}), each string field
 * {@link MAX_FIELD_LEN}; `wip` kept only as a finite positive number; a card/column missing a required
 * id/title (or over-length) is dropped. Returns `undefined` (not an empty projection) when nothing
 * survives, so {@link sanitizeSnapshot} omits the field. Does NOT cross-validate a card's `columnId`
 * against the columns — the host GROUPER ({@link buildBoardCards}) drops a dangling card on read.
 */
function sanitizeKanban(input: unknown): KanbanMirror | undefined {
  if (!input || typeof input !== 'object') return undefined
  const {
    columns,
    cards,
    columnAxis: rawAxis,
    axisLabel: rawLabel
  } = input as { columns?: unknown; cards?: unknown; columnAxis?: unknown; axisLabel?: unknown }
  const cols: KanbanColumnMirror[] = []
  if (Array.isArray(columns)) {
    for (const c of columns) {
      if (cols.length >= MAX_KANBAN_COLUMNS) break
      if (!c || typeof c !== 'object') continue
      const id = boundedStr((c as KanbanColumnMirror).id)
      const title = boundedStr((c as KanbanColumnMirror).title)
      if (id === undefined || title === undefined) continue
      const col: KanbanColumnMirror = { id, title }
      const wip = (c as KanbanColumnMirror).wip
      if (typeof wip === 'number' && Number.isFinite(wip) && wip > 0) col.wip = wip
      cols.push(col)
    }
  }
  const out: KanbanCardMirror[] = []
  if (Array.isArray(cards)) {
    for (const c of cards) {
      if (out.length >= MAX_KANBAN_CARDS) break
      if (!c || typeof c !== 'object') continue
      const id = boundedStr((c as KanbanCardMirror).id)
      const columnId = boundedStr((c as KanbanCardMirror).columnId)
      const title = boundedStr((c as KanbanCardMirror).title)
      if (id === undefined || columnId === undefined || title === undefined) continue
      const card: KanbanCardMirror = { id, columnId, title }
      const tag = boundedStr((c as KanbanCardMirror).tag)
      if (tag !== undefined) card.tag = tag
      const assignee = boundedStr((c as KanbanCardMirror).assignee)
      if (assignee !== undefined) card.assignee = assignee
      const ref = boundedStr((c as KanbanCardMirror).ref)
      if (ref !== undefined) card.ref = ref
      // v19 card-detail: description mirrors at FULL fidelity (truncated only at the 4000 write cap, not
      // the 500 planning preview) so the agent read→update loop is lossless; tags/fileRefs are bounded
      // lists (count + per-field capped).
      const rec = c as Record<string, unknown>
      const description = boundedText(rec.description, MAX_KANBAN_CARD_DESCRIPTION)
      if (description !== undefined) card.description = description
      const tags = sanitizeCardTags(rec.tags)
      if (tags !== undefined) card.tags = tags
      const fileRefs = sanitizeCardFileRefs(rec.fileRefs)
      if (fileRefs !== undefined) card.fileRefs = fileRefs
      // #346 attachments: blob refs (assetId + metadata) — validated/count-capped, read-only.
      const attachments = sanitizeCardAttachments(rec.attachments)
      if (attachments !== undefined) card.attachments = attachments
      out.push(card)
    }
  }
  // v19 board axis: keep only the two-value enum + a bounded single-line label (bad/absent ⇒ dropped,
  // read as 'flow' downstream). The mirror carries them so canvas://board/{id}/cards can project them.
  const columnAxis = rawAxis === 'flow' || rawAxis === 'category' ? rawAxis : undefined
  const axisLabel = boundedStr(rawLabel)
  if (
    cols.length === 0 &&
    out.length === 0 &&
    columnAxis === undefined &&
    axisLabel === undefined
  ) {
    return undefined
  }
  const mirror: KanbanMirror = { columns: cols, cards: out }
  if (columnAxis !== undefined) mirror.columnAxis = columnAxis
  if (axisLabel !== undefined) mirror.axisLabel = axisLabel
  return mirror
}

/**
 * Keep only well-formed {id,type,title} string entries; drop anything else.
 * Bounded: at most MAX_BOARDS entries, each field at most MAX_FIELD_LEN chars —
 * the renderer is trusted, but mcp:boards is an IPC channel, so a malformed/oversized
 * payload is capped rather than retained wholesale. `type` is intentionally left an
 * open string (forward board types are allowed); an unrecognized type maps to status
 * 'unknown' downstream rather than being dropped.
 */
export function sanitizeSnapshot(input: unknown): BoardMirror[] {
  if (!Array.isArray(input)) return []
  const out: BoardMirror[] = []
  for (const b of input) {
    if (out.length >= MAX_BOARDS) break
    if (
      b &&
      typeof b === 'object' &&
      typeof (b as BoardMirror).id === 'string' &&
      typeof (b as BoardMirror).type === 'string' &&
      typeof (b as BoardMirror).title === 'string'
    ) {
      const {
        id,
        type,
        title,
        status,
        agentKind,
        monitorActivity,
        path,
        fileRefs,
        x,
        y,
        w,
        h,
        kanban,
        planning
      } = b as BoardMirror
      if (
        id.length > MAX_FIELD_LEN ||
        type.length > MAX_FIELD_LEN ||
        title.length > MAX_FIELD_LEN
      ) {
        continue
      }
      const entry: BoardMirror = { id, type, title }
      // Attach status only when it is a known bucket; an invalid/absent value is
      // dropped so the adapter falls back rather than forwarding garbage.
      if (typeof status === 'string' && STATUS_BUCKETS.has(status)) entry.status = status
      // v10 agent identity (Phase B): agentKind is an open string, length-capped like the
      // others (over-length / non-string → field dropped, board kept — a forward preset id is
      // valid). monitorActivity is attached only as a strict boolean (anything else → absent,
      // which reads as monitored downstream — the safe default).
      if (typeof agentKind === 'string' && agentKind.length <= MAX_FIELD_LEN) {
        entry.agentKind = agentKind
      }
      if (typeof monitorActivity === 'boolean') entry.monitorActivity = monitorActivity
      // file-tree S5: file board path (length-capped string) + planning fileRefs (bounded list).
      // The renderer only sets these for the relevant board type, but mcp:boards is an IPC
      // channel, so validate/cap rather than trust — a bad value drops the field, keeps the board.
      if (typeof path === 'string' && path.length > 0 && path.length <= MAX_FIELD_LEN) {
        entry.path = path
      }
      const refs = sanitizeFileRefs(fileRefs)
      if (refs !== undefined) entry.fileRefs = refs
      // P1 canvas awareness: attach world-space geometry only as FINITE numbers (a non-number /
      // NaN / ∞ over IPC drops that field, keeps the board — mirrors the agentKind/path discipline).
      if (typeof x === 'number' && Number.isFinite(x)) entry.x = x
      if (typeof y === 'number' && Number.isFinite(y)) entry.y = y
      if (typeof w === 'number' && Number.isFinite(w)) entry.w = w
      if (typeof h === 'number' && Number.isFinite(h)) entry.h = h
      // P3b: a kanban board's bounded lanes+cards (validated/capped; absent otherwise).
      const sanitizedKanban = sanitizeKanban(kanban)
      if (sanitizedKanban !== undefined) entry.kanban = sanitizedKanban
      // S6: a planning board's bounded elements+ids (validated/capped; absent otherwise).
      const sanitizedPlanning = sanitizePlanning(planning)
      if (sanitizedPlanning !== undefined) entry.planning = sanitizedPlanning
      out.push(entry)
    }
  }
  return out
}

/**
 * Keep only well-formed {id,sourceId,targetId,kind} connector entries; drop anything else.
 * Bounded like {@link sanitizeSnapshot} — mcp:boards is an IPC channel, so a malformed/
 * oversized payload is capped. An unrecognized `kind` is dropped (never forwarded).
 */
export function sanitizeConnectors(input: unknown): ConnectorMirror[] {
  if (!Array.isArray(input)) return []
  const out: ConnectorMirror[] = []
  for (const c of input) {
    if (out.length >= MAX_CONNECTORS) break
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as ConnectorMirror).id === 'string' &&
      typeof (c as ConnectorMirror).sourceId === 'string' &&
      typeof (c as ConnectorMirror).targetId === 'string' &&
      typeof (c as ConnectorMirror).kind === 'string' &&
      CONNECTOR_KINDS.has((c as ConnectorMirror).kind)
    ) {
      const { id, sourceId, targetId, kind } = c as ConnectorMirror
      if (
        id.length > MAX_FIELD_LEN ||
        sourceId.length > MAX_FIELD_LEN ||
        targetId.length > MAX_FIELD_LEN
      ) {
        continue
      }
      out.push({ id, sourceId, targetId, kind })
    }
  }
  return out
}

/**
 * Keep only well-formed {id,name,boardIds:string[]} group entries; drop anything else (PR-5).
 * Bounded like {@link sanitizeSnapshot} — mcp:boards is an IPC channel, so a malformed/oversized
 * payload is capped: at most MAX_GROUPS groups, MAX_FIELD_LEN per id/name, MAX_GROUP_MEMBERS
 * boardIds each (non-string / over-length members dropped). A board may belong to many groups, so
 * `boardIds` is NOT cross-validated against the live board set here — `name` is an open string.
 */
export function sanitizeGroups(input: unknown): GroupMirror[] {
  if (!Array.isArray(input)) return []
  const out: GroupMirror[] = []
  for (const g of input) {
    if (out.length >= MAX_GROUPS) break
    if (
      g &&
      typeof g === 'object' &&
      typeof (g as GroupMirror).id === 'string' &&
      typeof (g as GroupMirror).name === 'string' &&
      Array.isArray((g as GroupMirror).boardIds)
    ) {
      const { id, name, boardIds } = g as GroupMirror
      if (id.length > MAX_FIELD_LEN || name.length > MAX_FIELD_LEN) continue
      const members: string[] = []
      for (const bid of boardIds) {
        if (members.length >= MAX_GROUP_MEMBERS) break
        if (typeof bid === 'string' && bid.length <= MAX_FIELD_LEN) members.push(bid)
      }
      out.push({ id, name, boardIds: members })
    }
  }
  return out
}

/** Last snapshot the renderer pushed (empty until the renderer mounts + publishes). */
export function listBoardMirror(): BoardMirror[] {
  return mirror
}

/** Last connector snapshot the renderer pushed (orchestration + preview edges). */
export function listConnectors(): ConnectorMirror[] {
  return connectorMirror
}

/** Last Named Group snapshot the renderer pushed (PR-5; empty until the renderer publishes). */
export function listGroups(): GroupMirror[] {
  return groupMirror
}

/** Test seam — set the mirror directly (unit tests only). */
export function __setMirrorForTest(next: BoardMirror[]): void {
  mirror = next
}

/** Test seam — set the connector mirror directly (unit tests only). */
export function __setConnectorsForTest(next: ConnectorMirror[]): void {
  connectorMirror = next
}

/** Test seam — set the group mirror directly (unit tests only). */
export function __setGroupsForTest(next: GroupMirror[]): void {
  groupMirror = next
}

/**
 * Register the renderer→MAIN board-snapshot channel. Sender-guarded so only the
 * main window's main frame can publish (mirrors pty.ts's isForeignSender). The
 * snapshot is control-plane metadata only — never board content.
 *
 * Accepts either the legacy boards-only array OR the `{ boards, connectors, groups }` payload
 * (T4.6 added connectors; PR-5 added groups). An array → connectors + groups stay [].
 */
export function registerBoardRegistryHandler(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.on('mcp:boards', (e: IpcMainEvent, payload: unknown) => {
    // BUG-033: use the canonical isForeignSender (ipcGuard.ts) instead of the stale inline copy.
    // The inline copy failed OPEN when getWin() returned null (boot window before createWindow),
    // and threw "Object has been destroyed" on a destroyed-but-non-null window.
    if (isForeignSender(e, getWin)) return
    if (Array.isArray(payload)) {
      // Legacy / version-skew only: a renderer predating T4.6 sends a bare boards array.
      applySnapshot(sanitizeSnapshot(payload), [], [])
    } else if (payload && typeof payload === 'object') {
      const { boards, connectors, groups } = payload as {
        boards?: unknown
        connectors?: unknown
        groups?: unknown
      }
      applySnapshot(
        sanitizeSnapshot(boards),
        sanitizeConnectors(connectors),
        sanitizeGroups(groups)
      )
    }
  })
}

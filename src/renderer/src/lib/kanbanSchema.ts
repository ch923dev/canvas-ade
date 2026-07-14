/**
 * Kanban board schema pieces (v17, MCP canvas-awareness P4). Split out of `boardSchema.ts` so that
 * file stays under the max-lines gate as the `Board` union grows per new type. Holds the persisted
 * shapes (ordered `columns` + a flat `cards` list) and the default lanes a fresh board starts with.
 *
 * The back-reference to `BoardCommon` is TYPE-ONLY (erased at compile), and this module has no runtime
 * dependency on `boardSchema.ts` — so `boardSchema.ts` importing `DEFAULT_KANBAN_COLUMNS` from here is a
 * one-way runtime edge, no cycle. `boardSchema.ts` re-exports these types, so consumers still import
 * `KanbanBoard`/`KanbanCard`/`KanbanColumn` from `./boardSchema` unchanged.
 */
import type { BoardCommon } from './boardSchema'

/**
 * v19: a file+line reference a card points at (card-detail epic). `path` is project-root-relative
 * (same convention as the `file` board / `fileref` Planning element); the optional 1-based `line`/
 * `endLine` open the file scrolled to that spot. No live re-anchoring — an immutable pointer, matching
 * the industry retreat from re-anchoring code refs (research 2026-07-14). Absent line ⇒ open at top.
 */
export interface KanbanFileRef {
  /** Project-root-relative path of the file this card touches. */
  path: string
  /** 1-based start line to open at. Absent ⇒ open at the file's top. */
  line?: number
  /** 1-based end line of the range (inclusive). Absent ⇒ a single-line ref. */
  endLine?: number
}

/**
 * v17→v19: one card on a Kanban board. A card is bound to a column by `columnId` (a flat card list, not
 * nested-per-column, so an MCP `move_card` is a single-field patch and within-column order is array
 * order — mirrors Planning's flat `elements[]`). Only `id`/`columnId`/`title` are required; the rest is
 * optional presentation. v19 (card-detail epic) adds `description` + `tags[]` + `fileRefs[]` — all
 * additive, defaulted-at-read, so the writer bumps to 19 while the compat floor stays 17.
 */
export interface KanbanCard {
  id: string
  /** The id of the {@link KanbanColumn} this card sits in. A dangling ref is dropped on read. */
  columnId: string
  title: string
  /**
   * @deprecated v19 — the legacy SINGLE free-text chip. Still read (as a fallback into `tags`) so
   * pre-v19 boards render unchanged, but new edits write `tags`. Absent ⇒ fall through to `tags`.
   */
  tag?: string
  /** v19: free-text label chips (supersedes the singular `tag`). Absent ⇒ fall back to `tag`, else none. */
  tags?: string[]
  /** v19: long-form plain-text description. Shown in the card-detail modal, NEVER on the card face (Linear rule). Absent ⇒ none. */
  description?: string
  /** v19: file+line references this card touches — click a ref to open the file at that line. Absent ⇒ none. */
  fileRefs?: KanbanFileRef[]
  /** Assignee agent-preset id (mirrors TerminalBoard.agentKind: 'claude'|'codex'|…) — the dot. Absent ⇒ unassigned. */
  assignee?: string
  /** Free-text external reference chip (e.g. "PR #271"). Absent ⇒ none. */
  ref?: string
}

/** v17: one column (lane) on a Kanban board. Array order in `columns` = left-to-right display order. */
export interface KanbanColumn {
  id: string
  title: string
  /** Optional WIP limit → the "WIP n/limit" badge. Absent ⇒ no limit shown. */
  wip?: number
}

/**
 * v17: the Kanban board — a dedicated full-board Trello-style plan visualizer. Unlike `command`/
 * `dataflow` (ephemeral bodies), a Kanban board PERSISTS its content: ordered `columns` + a flat
 * `cards` list. A new board type is breaking → schema v17 / floor 17.
 */
export interface KanbanBoard extends BoardCommon {
  type: 'kanban'
  columns: KanbanColumn[]
  cards: KanbanCard[]
}

/**
 * The four columns a freshly-created Kanban board starts with (the P4 mock). The ids are stable
 * slugs — unique WITHIN a board is all a `card.columnId` needs, so a fixed set is safe and keeps
 * `createBoard` deterministic (no id generation for the default lanes).
 */
export const DEFAULT_KANBAN_COLUMNS: readonly KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'in-progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' }
]

/**
 * Deep-validate a kanban board's persisted content (columns + cards) — extracted from
 * boardSchema.ts's `assertBoard` kanban case at the board-inspector epic merge (the union of the
 * Kanban v17 validation and the P4b appearance validation tipped boardSchema.ts over the
 * max-lines gate; this cluster lives with its types). Same contract as in place: shape checks
 * ONLY — a card whose columnId matches no column is a stale ref DROPPED in fromObject (not failed
 * here), matching the previewSourceId/dataflow reconcile discipline. The primitive guards arrive
 * injected so this stays a leaf module (no runtime import back into boardSchema.ts).
 */
export function assertKanbanContent(
  b: Record<string, unknown>,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>,
  isPositiveNum: (v: unknown) => v is number
): void {
  // v17: columns + cards are required arrays. A column needs id/title strings (+ optional positive
  // wip — mirrors kanbanEdit.ts's setColumnWip, which only ever persists a finite `wip > 0` and
  // clears it to `undefined` otherwise, so a non-positive value here can only be a hand-edited/
  // adversarial doc); a card needs id/columnId/title strings (+ optional string chips).
  if (!Array.isArray(b.columns)) fail('kanban board columns is not an array')
  for (const c of b.columns as unknown[]) {
    if (!isRecord(c)) fail('kanban column is not an object')
    if (typeof c.id !== 'string') fail('kanban column has a non-string id')
    if (typeof c.title !== 'string') fail('kanban column has a non-string title')
    if (c.wip !== undefined && !isPositiveNum(c.wip)) {
      fail('kanban column wip is not a positive number')
    }
  }
  if (!Array.isArray(b.cards)) fail('kanban board cards is not an array')
  for (const c of b.cards as unknown[]) {
    if (!isRecord(c)) fail('kanban card is not an object')
    if (typeof c.id !== 'string') fail('kanban card has a non-string id')
    if (typeof c.columnId !== 'string') fail('kanban card has a non-string columnId')
    if (typeof c.title !== 'string') fail('kanban card has a non-string title')
    // The singular chips + the v19 plain-text `description` stay string-optional.
    for (const k of ['tag', 'assignee', 'ref', 'description'] as const) {
      if (c[k] !== undefined && typeof c[k] !== 'string') fail(`kanban card ${k} is not a string`)
    }
    // v19 card-detail: `tags` is a string list; `fileRefs` is a list of {path, line?, endLine?}. Same
    // shape-only discipline as above — a malformed entry fails the doc (an empty list is fine), while a
    // fileRef with no matching file is NOT checked here (a ref is a free pointer, resolved on click).
    if (c.tags !== undefined) {
      if (!Array.isArray(c.tags)) fail('kanban card tags is not an array')
      for (const t of c.tags as unknown[]) {
        if (typeof t !== 'string') fail('kanban card tags entry is not a string')
      }
    }
    if (c.fileRefs !== undefined) {
      if (!Array.isArray(c.fileRefs)) fail('kanban card fileRefs is not an array')
      for (const r of c.fileRefs as unknown[]) {
        if (!isRecord(r)) fail('kanban card fileRef is not an object')
        if (typeof r.path !== 'string') fail('kanban card fileRef has a non-string path')
        for (const k of ['line', 'endLine'] as const) {
          if (r[k] !== undefined && !isPositiveNum(r[k])) {
            fail(`kanban card fileRef ${k} is not a positive number`)
          }
        }
      }
    }
  }
}

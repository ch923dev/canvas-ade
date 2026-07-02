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
 * v17: one card on a Kanban board. A card is bound to a column by `columnId` (a flat card list, not
 * nested-per-column, so an MCP `move_card` is a single-field patch and within-column order is array
 * order — mirrors Planning's flat `elements[]`). Only `id`/`columnId`/`title` are required; the chips
 * are optional presentation.
 */
export interface KanbanCard {
  id: string
  /** The id of the {@link KanbanColumn} this card sits in. A dangling ref is dropped on read. */
  columnId: string
  title: string
  /** Free-text status/type chip (e.g. "feature", "research", "needs review", "shipped"). Absent ⇒ none. */
  tag?: string
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
    for (const k of ['tag', 'assignee', 'ref'] as const) {
      if (c[k] !== undefined && typeof c[k] !== 'string') fail(`kanban card ${k} is not a string`)
    }
  }
}

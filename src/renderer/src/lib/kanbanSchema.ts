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

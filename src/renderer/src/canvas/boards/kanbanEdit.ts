/**
 * Pure edit operations for a Kanban board's human interaction (v17, MCP canvas-awareness P4.2).
 * Each function takes the board + intent and returns the NEW `columns`/`cards` array (never mutates),
 * so `KanbanBoard` can commit it via `updateBoard` as ONE undoable, autosaved edit — mirroring
 * `kanbanMcpApply.applyKanbanOps` (the agent path) but keyed off direct human intent instead of a
 * confirmed op batch. Pure ⇒ unit-tested in isolation; the component stays presentational.
 *
 * Guards match the schema contract: a card needs a non-empty title, a column needs a non-empty title,
 * `columnId` order is array order, and a Kanban board must keep at least one column (`removeColumn`
 * refuses the last one). Empty-input commits are treated as no-ops (return the input array unchanged)
 * so the caller can blindly commit on blur without special-casing.
 */
import type { KanbanBoard, KanbanCard, KanbanColumn } from '../../lib/boardSchema'

const newId = (): string => crypto.randomUUID()

// ── card ops (return the new `cards` array) ──────────────────────────────────

/** Append a new card (fresh id) to `columnId`'s tail. Empty/blank title ⇒ no-op. */
export function addCard(board: KanbanBoard, columnId: string, title: string): KanbanCard[] {
  const t = title.trim()
  if (!t) return board.cards
  return [...board.cards, { id: newId(), columnId, title: t }]
}

/** Retitle a card. Blank or unchanged title ⇒ ref-stable no-op (a card must keep a title). */
export function renameCard(board: KanbanBoard, cardId: string, title: string): KanbanCard[] {
  const t = title.trim()
  const cur = board.cards.find((c) => c.id === cardId)
  if (!t || !cur || cur.title === t) return board.cards
  return board.cards.map((c) => (c.id === cardId ? { ...c, title: t } : c))
}

/** Drop a card. Unknown id ⇒ returns the same array (map/filter no-op). */
export function removeCard(board: KanbanBoard, cardId: string): KanbanCard[] {
  return board.cards.filter((c) => c.id !== cardId)
}

/**
 * Move a card to `toColumnId`, re-appending it to that column's tail (array order = within-column
 * order, matching the agent `move` op). Same-column or unknown card ⇒ no-op. Unknown target column ⇒
 * no-op (defensive; the UI only ever passes a real column id).
 */
export function moveCard(board: KanbanBoard, cardId: string, toColumnId: string): KanbanCard[] {
  const card = board.cards.find((c) => c.id === cardId)
  if (!card || card.columnId === toColumnId) return board.cards
  if (!board.columns.some((c) => c.id === toColumnId)) return board.cards
  return [...board.cards.filter((c) => c.id !== cardId), { ...card, columnId: toColumnId }]
}

// ── column ops ───────────────────────────────────────────────────────────────

/** Append a new lane (fresh id) to the right. Blank title ⇒ no-op. */
export function addColumn(board: KanbanBoard, title: string): KanbanColumn[] {
  const t = title.trim()
  if (!t) return board.columns
  return [...board.columns, { id: newId(), title: t }]
}

/** Retitle a lane. Blank or unchanged title ⇒ ref-stable no-op (a column must keep a title). */
export function renameColumn(board: KanbanBoard, columnId: string, title: string): KanbanColumn[] {
  const t = title.trim()
  const cur = board.columns.find((c) => c.id === columnId)
  if (!t || !cur || cur.title === t) return board.columns
  return board.columns.map((c) => (c.id === columnId ? { ...c, title: t } : c))
}

/**
 * Set or clear a lane's WIP limit. A positive finite `wip` sets the limit (floored); `undefined` /
 * zero / non-finite clears it (the badge disappears). WIP is SOFT — nothing here blocks a move; the
 * board just paints the badge in the warn colour when the live card count reaches the limit.
 */
export function setColumnWip(
  board: KanbanBoard,
  columnId: string,
  wip: number | undefined
): KanbanColumn[] {
  const limit = wip !== undefined && Number.isFinite(wip) && wip > 0 ? Math.floor(wip) : undefined
  const cur = board.columns.find((c) => c.id === columnId)
  // No change (unknown column, or the limit already matches — both-undefined included) ⇒ same ref.
  if (!cur || cur.wip === limit) return board.columns
  return board.columns.map((c) => {
    if (c.id !== columnId) return c
    if (limit === undefined) return { id: c.id, title: c.title }
    return { ...c, wip: limit }
  })
}

/**
 * Remove a lane, reflowing its cards to the neighbouring lane (the one that slides into its place, or
 * the previous lane when it was the last) so NO card is silently lost. Returns `null` — a refused
 * edit — for an unknown column or the last remaining column (a Kanban board keeps ≥1 lane).
 */
export function removeColumn(
  board: KanbanBoard,
  columnId: string
): { columns: KanbanColumn[]; cards: KanbanCard[] } | null {
  if (board.columns.length <= 1) return null
  const idx = board.columns.findIndex((c) => c.id === columnId)
  if (idx < 0) return null
  const columns = board.columns.filter((c) => c.id !== columnId)
  const fallback = (columns[idx] ?? columns[idx - 1]).id
  const cards = board.cards.map((c) => (c.columnId === columnId ? { ...c, columnId: fallback } : c))
  return { columns, cards }
}

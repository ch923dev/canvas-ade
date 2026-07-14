/**
 * Apply sanitized {@link KanbanOp}s to a Kanban board's cards (P3, MCP card mutation). Pure:
 * `applyKanbanOps` takes the board + ops and returns the NEW `cards` array (never mutates the input),
 * so `useMcpCommands`'s `patchKanban` handler can commit it via `updateBoard` as one undoable edit,
 * and it unit-tests directly. MAIN already resolved + kanban-checked the board, minted any new card
 * id, and human-confirmed the ops; this re-validates as DEFENSE IN DEPTH (the target column/card must
 * exist, no duplicate id) and throws on any mismatch so the renderer acks `{ok:false}` and nothing
 * lands — mirroring the planning applier's re-validate-before-commit discipline.
 */
import type { KanbanBoard, KanbanCard } from '../lib/boardSchema'
import type { KanbanOp } from '../../../shared/mcpTypes'

/**
 * Cumulative cap on cards a single Kanban board may hold — a resource guard the renderer enforces
 * (only it knows the live count; the host caps each op-batch). Reject, don't truncate, so the agent
 * learns nothing landed.
 */
export const MAX_KANBAN_BOARD_CARDS = 500

/** Merge only the SUPPLIED fields of an update patch onto a card (a patch never clears a field). */
function mergeCard(
  card: KanbanCard,
  patch: Extract<KanbanOp, { op: 'update' }>['patch']
): KanbanCard {
  const next: KanbanCard = {
    ...card,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.tag !== undefined ? { tag: patch.tag } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
    ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
    // v19 card-detail: only the supplied fields change (a patch never clears one).
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.fileRefs !== undefined ? { fileRefs: patch.fileRefs } : {})
  }
  // v19: writing `tags` supersedes + sheds the legacy singular `tag` (matches human setCardTags).
  if (patch.tags === undefined) return next
  const { tag: _legacy, ...rest } = next
  return { ...rest, tags: patch.tags }
}

/**
 * Fold `ops` over the board's current cards, returning the new cards array. Throws on an op that
 * references an unknown column (add/move) or an unknown/duplicate card id — so a bad batch lands
 * nothing. `move` re-appends the card to the array tail so it renders at the BOTTOM of its new column
 * (within-column order is array order).
 */
export function applyKanbanOps(board: KanbanBoard, ops: readonly KanbanOp[]): KanbanCard[] {
  const columnIds = new Set(board.columns.map((c) => c.id))
  let cards: KanbanCard[] = board.cards.slice()
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        if (!columnIds.has(op.card.columnId)) throw new Error(`unknown column: ${op.card.columnId}`)
        if (cards.some((c) => c.id === op.card.id)) {
          throw new Error(`duplicate card id: ${op.card.id}`)
        }
        const src = op.card
        const card: KanbanCard = {
          id: src.id,
          columnId: src.columnId,
          title: src.title,
          ...(src.assignee !== undefined ? { assignee: src.assignee } : {}),
          ...(src.ref !== undefined ? { ref: src.ref } : {}),
          // v19 card-detail fields (agent write).
          ...(src.description !== undefined ? { description: src.description } : {}),
          ...(src.fileRefs !== undefined ? { fileRefs: src.fileRefs } : {}),
          // `tags` supersedes the legacy singular `tag` — a card carries only one of the two.
          ...(src.tags !== undefined
            ? { tags: src.tags }
            : src.tag !== undefined
              ? { tag: src.tag }
              : {})
        }
        cards = [...cards, card]
        break
      }
      case 'move': {
        const card = cards.find((c) => c.id === op.cardId)
        if (!card) throw new Error(`unknown card: ${op.cardId}`)
        if (!columnIds.has(op.toColumnId)) throw new Error(`unknown column: ${op.toColumnId}`)
        cards = [...cards.filter((c) => c.id !== op.cardId), { ...card, columnId: op.toColumnId }]
        break
      }
      case 'update': {
        const i = cards.findIndex((c) => c.id === op.cardId)
        if (i < 0) throw new Error(`unknown card: ${op.cardId}`)
        cards = cards.map((c, j) => (j === i ? mergeCard(c, op.patch) : c))
        break
      }
      case 'remove': {
        if (!cards.some((c) => c.id === op.cardId)) throw new Error(`unknown card: ${op.cardId}`)
        cards = cards.filter((c) => c.id !== op.cardId)
        break
      }
    }
  }
  if (cards.length > MAX_KANBAN_BOARD_CARDS) throw new Error('kanban board card cap exceeded')
  return cards
}

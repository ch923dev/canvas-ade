/**
 * 🔒 P3b canvas-awareness read projection — a PURE host-side grouper that turns one board's flat,
 * already-sanitized kanban mirror ({@link KanbanMirror}: ordered `columns` + a flat `cards` list) into
 * the agent-facing GROUPED shape served as the `canvas://board/{id}/cards` MCP resource (cards nested
 * under their column, in array order). It is the READ half of the card loop: an agent reads it to see a
 * Kanban board's live lanes + cards BEFORE it mutates them (add/move/update/remove_card, P3a).
 *
 * PURE (no electron / @expanse-ade/mcp imports): it takes the sanitized mirror projection and returns a
 * plain object, so it unit-tests in isolation and carries no runtime coupling. The mirror is already
 * validated + capped on ingest (`boardRegistry.ts` `sanitizeKanban`) — this grouper trusts it and only
 * drops a DANGLING card (a `columnId` with no matching column; the schema drops them on read, so a live
 * board shouldn't have any — defensive anyway). `BoardCards` is HOST-OWNED: the package types the
 * resource `unknown` and serializes it, mirroring `describeApp`/`describeLayout`.
 */

/** The minimal board shape {@link buildBoardCards} reads (structurally the mirror / registry entry). */
export interface BoardCardsInput {
  id: string
  title: string
  type: string
  kanban?: {
    columns: ReadonlyArray<{ id: string; title: string; wip?: number }>
    cards: ReadonlyArray<{
      id: string
      columnId: string
      title: string
      tag?: string
      assignee?: string
      ref?: string
    }>
  }
}

/** One card in the grouped `canvas://board/{id}/cards` projection — chips omitted when absent. */
export interface BoardCardsCard {
  id: string
  title: string
  tag?: string
  assignee?: string
  ref?: string
}

/** One column (lane) in the grouped projection — its cards nested in array order. */
export interface BoardCardsColumn {
  id: string
  title: string
  /** WIP limit as a positive number, or `null` when unset (always present so an agent needn't probe). */
  wip: number | null
  cards: BoardCardsCard[]
}

/**
 * The read-only projection served as `canvas://board/{id}/cards` (P3b). A non-kanban board (or one
 * with no kanban projection) returns the graceful shell `{ …, isKanban: false, columns: [] }` — an
 * agent may probe any id, so this never throws (board-not-found is thrown by the caller instead).
 */
export interface BoardCards {
  boardId: string
  title: string
  isKanban: boolean
  columns: BoardCardsColumn[]
}

/** Copy a card's optional chips onto the output card (omit — never emit an empty string). */
function withChips(c: NonNullable<BoardCardsInput['kanban']>['cards'][number]): BoardCardsCard {
  const card: BoardCardsCard = { id: c.id, title: c.title }
  if (c.tag) card.tag = c.tag
  if (c.assignee) card.assignee = c.assignee
  if (c.ref) card.ref = c.ref
  return card
}

/**
 * Group a board's sanitized kanban mirror into the {@link BoardCards} resource shape. Non-kanban /
 * projection-less boards return the graceful non-kanban shell. Cards are grouped under their column in
 * array order; a dangling card (no matching column) is dropped.
 */
export function buildBoardCards(board: BoardCardsInput): BoardCards {
  if (board.type !== 'kanban' || !board.kanban) {
    return { boardId: board.id, title: board.title, isKanban: false, columns: [] }
  }
  const columns: BoardCardsColumn[] = board.kanban.columns.map((col) => ({
    id: col.id,
    title: col.title,
    wip: typeof col.wip === 'number' ? col.wip : null,
    cards: []
  }))
  const byId = new Map(columns.map((col) => [col.id, col]))
  for (const c of board.kanban.cards) {
    const col = byId.get(c.columnId)
    if (col) col.cards.push(withChips(c)) // drop dangling cards (columnId with no column)
  }
  return { boardId: board.id, title: board.title, isKanban: true, columns }
}

/**
 * Factory for the orchestrator's `boardCards` loopback method (P3b) — kept OUT of `mcpOrchestrator.ts`
 * (which sits at the max-lines cap) and spread into its return object, the extract-on-touch pattern
 * `createKanbanMethods`/`createVisualizeMethod` use. Resolves the board from the live mirror and
 * groups it via {@link buildBoardCards}; an unknown id throws (an agent may probe any id — a wrong
 * TYPE reads the graceful shell, a wrong ID is a genuine "no such board").
 */
export function createBoardCardsMethod(listBoards: () => ReadonlyArray<BoardCardsInput>): {
  boardCards(boardId: string): Promise<BoardCards>
} {
  return {
    async boardCards(boardId) {
      const board = listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`canvas://board/${boardId}/cards: board not found: ${boardId}`)
      return buildBoardCards(board)
    }
  }
}

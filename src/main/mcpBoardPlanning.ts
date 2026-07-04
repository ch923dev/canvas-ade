/**
 * 🔒 S6 canvas-awareness read projection — a PURE host-side projector that turns one board's flat,
 * already-sanitized planning mirror ({@link PlanningMirror}: `elements` with ids + editable fields) into
 * the agent-facing shape served as the `canvas://board/{id}/planning` MCP resource. It is the READ half
 * of the edit loop: an agent reads it to learn each element's id (and, for a checklist, its item ids +
 * done state) BEFORE it mutates them in place (update_planning_element / remove_planning_element, S6) —
 * instead of re-appending a fresh copy (which stacks stale duplicates, the bug this closes).
 *
 * PURE (no electron / @expanse-ade/mcp imports): it takes the sanitized mirror projection and returns a
 * plain object, so it unit-tests in isolation and carries no runtime coupling. The mirror is already
 * validated + capped on ingest (`boardRegistry.ts` `sanitizePlanning`) — this projector trusts it and
 * only omits an absent optional field. `BoardPlanning` is HOST-OWNED: the package types the resource
 * `unknown` and serializes it, mirroring `buildBoardCards` / `describeApp`.
 */

/** One checklist item in the `canvas://board/{id}/planning` projection (S6). */
export interface BoardPlanningItem {
  id: string
  label: string
  done: boolean
}

/** One element in the projection (S6) — always id+kind; editable fields present only for their kind. */
export interface BoardPlanningElement {
  id: string
  kind: string
  text?: string
  tint?: string
  title?: string
  source?: string
  items?: BoardPlanningItem[]
}

/** The minimal board shape {@link buildBoardPlanning} reads (structurally the mirror / registry entry). */
export interface BoardPlanningInput {
  id: string
  title: string
  type: string
  planning?: {
    elements: ReadonlyArray<{
      id: string
      kind: string
      text?: string
      tint?: string
      title?: string
      source?: string
      items?: ReadonlyArray<{ id: string; label: string; done: boolean }>
    }>
  }
}

/**
 * The read-only projection served as `canvas://board/{id}/planning` (S6). A non-planning board (or one
 * with no planning projection) returns the graceful shell `{ …, isPlanning: false, elements: [] }` — an
 * agent may probe any id, so this never throws (board-not-found is thrown by the caller instead).
 */
export interface BoardPlanning {
  boardId: string
  title: string
  isPlanning: boolean
  elements: BoardPlanningElement[]
}

/** Copy one mirror element to the output, omitting an absent optional field (never emit undefined). */
function projectElement(
  e: NonNullable<BoardPlanningInput['planning']>['elements'][number]
): BoardPlanningElement {
  const el: BoardPlanningElement = { id: e.id, kind: e.kind }
  if (e.text !== undefined) el.text = e.text
  if (e.tint !== undefined) el.tint = e.tint
  if (e.title !== undefined) el.title = e.title
  if (e.source !== undefined) el.source = e.source
  if (e.items !== undefined) {
    el.items = e.items.map((it) => ({ id: it.id, label: it.label, done: it.done }))
  }
  return el
}

/**
 * Project a board's sanitized planning mirror into the {@link BoardPlanning} resource shape. Non-planning
 * / projection-less boards return the graceful non-planning shell. Elements ride out in array order (=
 * canvas paint order), each carrying its id + editable fields.
 */
export function buildBoardPlanning(board: BoardPlanningInput): BoardPlanning {
  if (board.type !== 'planning' || !board.planning) {
    return { boardId: board.id, title: board.title, isPlanning: false, elements: [] }
  }
  return {
    boardId: board.id,
    title: board.title,
    isPlanning: true,
    elements: board.planning.elements.map(projectElement)
  }
}

/**
 * Factory for the orchestrator's `boardPlanning` loopback method (S6) — kept OUT of `mcpOrchestrator.ts`
 * (which sits at the max-lines cap) and spread into its return object, the extract-on-touch pattern
 * `createBoardCardsMethod`/`createKanbanMethods` use. Resolves the board from the live mirror and projects
 * it via {@link buildBoardPlanning}; an unknown id throws (an agent may probe any id — a wrong TYPE reads
 * the graceful shell, a wrong ID is a genuine "no such board").
 */
export function createBoardPlanningMethod(listBoards: () => ReadonlyArray<BoardPlanningInput>): {
  boardPlanning(boardId: string): Promise<BoardPlanning>
} {
  return {
    async boardPlanning(boardId) {
      const board = listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`canvas://board/${boardId}/planning: board not found: ${boardId}`)
      return buildBoardPlanning(board)
    }
  }
}

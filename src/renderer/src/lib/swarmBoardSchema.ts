/**
 * SwarmBoard per-field validation + the shared dangling-reference load reconcile, extracted
 * from boardSchema (max-lines ratchet — the terminalBoardSchema/kanbanSchema precedent).
 * Guards are INJECTED so this leaf module never imports back into boardSchema.
 */

/** Shape-check the swarm board's ONE persisted per-type field (`dockLayout` — the divider-driven
 *  region sizes). Values are clamped at render (useDockLayout), so this only rejects non-numbers. */
export function assertSwarmContent(
  b: Record<string, unknown>,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>,
  isPositiveNum: (v: unknown) => v is number
): void {
  if (b.dockLayout === undefined) return
  if (!isRecord(b.dockLayout)) fail('swarm dockLayout is not an object')
  const l = b.dockLayout as { chat?: unknown; rail?: unknown; triage?: unknown }
  for (const k of ['chat', 'rail', 'triage'] as const) {
    if (l[k] !== undefined && !isPositiveNum(l[k])) {
      fail(`swarm dockLayout.${k} must be a positive number`)
    }
  }
}

/** The cross-board reference fields the load reconcile sweeps (structural — the caller passes
 *  fromObject's already-cloned boards; this mutates them in place like its former inline form). */
interface RefBearingBoard {
  id: string
  type: string
  previewSourceId?: string
  sourceBoardId?: string
  dockedIn?: string
}

/**
 * fromObject's dangling-reference sweep — clear, never fail, and the board reopens unbound:
 *  - a preview link whose source board is gone (Slice C′) or not a terminal (BUG-022: a
 *    non-terminal source can never appear in terminalRuntimeStore — permanently stale edge);
 *  - v14: a Data-Flow board's sourceBoardId whose bound source is gone or not a Browser board
 *    (a dataflow board only ever visualizes a Browser board's capture);
 *  - docked-terminals: a dockedIn whose host swarm board is gone or not a swarm board (a
 *    stranded reference would hide the terminal with nothing left to render it).
 */
export function dropDanglingBoardRefs(boards: RefBearingBoard[]): void {
  const terminalIds = new Set(boards.filter((b) => b.type === 'terminal').map((b) => b.id))
  const browserIds = new Set(boards.filter((b) => b.type === 'browser').map((b) => b.id))
  const swarmIds = new Set(boards.filter((b) => b.type === 'swarm').map((b) => b.id))
  for (const b of boards) {
    if (b.type === 'browser' && b.previewSourceId && !terminalIds.has(b.previewSourceId)) {
      delete b.previewSourceId
    }
    if (b.type === 'dataflow' && b.sourceBoardId && !browserIds.has(b.sourceBoardId)) {
      delete b.sourceBoardId
    }
    if (b.type === 'terminal' && b.dockedIn && !swarmIds.has(b.dockedIn)) delete b.dockedIn
  }
}

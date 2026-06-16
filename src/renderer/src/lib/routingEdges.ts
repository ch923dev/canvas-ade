/**
 * Pure derivation of EPHEMERAL routing-overlay edges (Phase C / C3) — the transient cables from the
 * singleton Command board to the worker boards it has in flight. Mirror of `previewEdges` /
 * `orchestrationEdges`: one RF edge per (in-flight task → present group member). DOM/React-Flow free
 * → unit-testable; Canvas decorates them with the arrow marker + the custom `routing` edge type.
 *
 * NOT persisted (never a `canvas.json` connector). Because the set is DERIVED from the live task→group
 * map, an edge appears when its task enters `routing`, stays through `executing`, and VANISHES the
 * instant the task settles (done/failed) or its card is cleared — no teardown bookkeeping.
 */
import type { Board } from './boardSchema'
import type { CommandTask } from '../store/commandStore'

/** The lifecycle phases that hold an in-flight routing edge (the worker is spawning / busy). */
export type RoutingPhase = 'routing' | 'executing'

export interface RoutingEdgeDesc {
  id: string
  source: string
  target: string
  type: 'routing'
  /** `routing` (group still spawning) renders fainter than `executing` (worker busy) — see RoutingEdge. */
  data: { phase: RoutingPhase }
}

/**
 * Routing edges from the Command board to each present member board of every in-flight task's group.
 * Skips: tasks not in flight; tasks with no group yet (routing reserved before `spawnGroup` resolves);
 * any member board no longer on the canvas (dangling-skip, like the sibling helpers). Returns [] when
 * there is no Command board on the canvas.
 */
export function routingEdges(
  tasks: ReadonlyArray<CommandTask>,
  boards: Board[]
): RoutingEdgeDesc[] {
  const command = boards.find((b) => b.type === 'command')
  if (!command) return []
  const present = new Set(boards.map((b) => b.id))
  const edges: RoutingEdgeDesc[] = []
  for (const task of tasks) {
    if (task.status !== 'routing' && task.status !== 'executing') continue
    const group = task.group
    if (!group) continue
    const phase: RoutingPhase = task.status
    for (const memberId of [group.terminalId, group.planningId, group.browserId]) {
      if (!memberId || memberId === command.id || !present.has(memberId)) continue
      edges.push({
        id: `routing-${task.id}-${memberId}`,
        source: command.id,
        target: memberId,
        type: 'routing',
        data: { phase }
      })
    }
  }
  return edges
}

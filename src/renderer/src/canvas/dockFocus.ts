/**
 * Docked-terminal focus redirect — the ONE rule every focus/navigation entry point shares
 * (PR #416 review). A DOCKED worker terminal (`dockedIn` set) has no React Flow node to fit
 * (filtered by `isCanvasVisibleBoard`) and its stored x/y are stale parking coordinates, so
 * aiming a camera verb at it either pans nowhere meaningful or — worse — sets a `focusedId`
 * with no node, which dims every visible board with nothing left un-dimmed (a dead end until
 * Esc). The redirect: activate the worker's tab in its host's dock, then aim the verb at the
 * HOST swarm board instead. Consumers: `focusBoardById` (Enter / double-click / minimap /
 * MCP focusCamera / file-tree open) and the palette's `goToBoard`; Tab-cycle instead skips
 * docked boards entirely (no node ⇒ no ring to land on).
 */
import { useCanvasStore } from '../store/canvasStore'
import { useDockStore } from '../store/dockStore'

/**
 * Resolve a focus target id: a docked worker resolves to its HOST swarm board (activating the
 * worker's dock tab as a side effect); everything else — including an unknown id, which the
 * caller's own board lookup will reject — passes through unchanged.
 */
export function resolveFocusTarget(id: string): string {
  const target = useCanvasStore.getState().boards.find((b) => b.id === id)
  const hostId = target?.type === 'terminal' ? target.dockedIn : undefined
  if (!hostId) return id
  useDockStore.getState().setActive(hostId, id)
  return hostId
}

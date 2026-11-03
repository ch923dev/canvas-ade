/**
 * WS-3 — which workspace a terminal spawns in, read from the store AT SPAWN TIME (design §4.2).
 *
 * Deliberately not a reactive subscription: membership is read when a spawn fires (mount, Start,
 * Restart), like `monitorActivity` / `openRouter`, so assigning a RUNNING terminal to a workspace
 * never kills its agent — the next Start/Restart is what moves it into the workspace root. The
 * renderer only proposes: MAIN resolves the root again from its own mirror and refuses a cwd
 * outside it (`ptyShells.resolveSpawnCwd`).
 */
import { useCanvasStore } from '../../../store/canvasStore'
import { effectiveRoot } from '../../../../../shared/workspaceRules'
import type { SpawnWorkspace } from './terminalSpawnMath'

/** The board's workspace (id + effective root), or `undefined` for a project-level board. An id
 *  the store no longer knows still goes to MAIN (root `null`) — MAIN refuses it with a sentence. */
export function spawnWorkspaceFor(boardId: string): SpawnWorkspace | undefined {
  const { boards, workspaces } = useCanvasStore.getState()
  const id = boards.find((b) => b.id === boardId)?.workspaceId
  if (!id) return undefined
  const ws = workspaces.find((w) => w.id === id)
  return { id, root: ws ? effectiveRoot(ws) : null }
}

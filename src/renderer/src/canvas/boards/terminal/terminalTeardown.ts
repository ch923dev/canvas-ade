import { useCanvasStore } from '../../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../../store/terminalRuntimeStore'

/**
 * Board-delete teardown for a terminal (#15 park-for-undo), shared by the two removal paths
 * (Canvas.tsx keyboard-delete intent + useBoardActions.remove — previously duplicated).
 *
 * Park the live session instead of killing it so undo can adopt the SAME process, and drop the
 * scrollback sidecar ONLY when the terminal had a LIVE session — park preserves that for undo,
 * so the snapshot is redundant; a restored-but-never-started (or exited) board has nothing
 * parkable, so its sidecar is the only copy and must survive for an immediate undo.
 *
 * #BUG-015: both invokes swallow rejections (teardown/channel-gone race on a closing window) so
 * they can't surface as unhandled promises. R2 dir-pin: the sidecar delete carries the project
 * it belongs to, so a delete racing a project switch can't remove a colliding board's sidecar
 * in the newly-active project (background sessions).
 */
export function parkTerminalForUndo(id: string): void {
  void window.api.parkTerminal(id).catch(() => {})
  if (useTerminalRuntimeStore.getState().running[id]) {
    const dir = useCanvasStore.getState().project.dir ?? undefined
    void window.api.terminal.deleteSnapshot(id, dir).catch(() => {})
  }
}

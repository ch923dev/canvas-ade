/**
 * Swarm docked-terminals — the "⇤ Re-dock" pill a POPPED-OUT worker terminal carries in its
 * title bar (design artifact dc48270d §2). Renders ONLY when this board is a live swarm run's
 * worker AND its host swarm board still exists — an ordinary terminal never shows it.
 *
 * Re-dock is the pop-out handoff in reverse: `parkTerminal` FIRST (the canvas board's unmount
 * `killTerminal` then no-ops), THEN set `dockedIn` in a history-neutral patch (a tracked flip
 * would let undo remount the terminal across surfaces and kill the live PTY — see SwarmDock).
 * The dock pane that mounts next adopts the parked session and replays its ring, and the tab
 * activates so the just-re-docked worker is the one on screen.
 */
import { useCallback, type ReactElement } from 'react'
import { patchBoardUntracked, useCanvasStore } from '../../../store/canvasStore'
import { useDockStore } from '../../../store/dockStore'
import { useSwarmStore } from '../../../store/swarmStore'

/** The swarm board id whose run claims this worker, or null (not a swarm worker). */
function hostSwarmIdFor(runs: Map<string, unknown>, boardId: string): string | null {
  for (const [swarmId, run] of runs as Map<string, { workerIds: string[] }>) {
    if (run.workerIds.includes(boardId)) return swarmId
  }
  return null
}

export function RedockPill({ boardId }: { boardId: string }): ReactElement | null {
  const hostId = useSwarmStore((s) => hostSwarmIdFor(s.runs, boardId))
  const hostLive = useCanvasStore(
    (s) => hostId !== null && s.boards.some((b) => b.id === hostId && b.type === 'swarm')
  )
  const redock = useCallback((): void => {
    if (!hostId) return
    void Promise.resolve(window.api.parkTerminal?.(boardId))
      .catch(() => {})
      .then(() => {
        patchBoardUntracked(boardId, { dockedIn: hostId })
        // A just-docked board must leave the selection (it has no RF node to deselect it) —
        // setSelection's docked filter drops it; re-passing the current ids applies it.
        const st = useCanvasStore.getState()
        if (st.selectedIds.includes(boardId)) st.setSelection(st.selectedIds)
        useDockStore.getState().setActive(hostId, boardId)
      })
  }, [boardId, hostId])
  if (!hostId || !hostLive) return null
  return (
    <button
      type="button"
      className="sw-redock nodrag"
      onClick={(e) => {
        e.stopPropagation()
        redock()
      }}
      title="Dock this worker back into its swarm board"
      data-test={`swarm-redock-${boardId}`}
    >
      ⇤ Re-dock
    </button>
  )
}

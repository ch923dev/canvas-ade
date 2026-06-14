/**
 * Board-level actions context value, extracted VERBATIM from Canvas.tsx (D4-A ratchet
 * payment — Canvas sits at its 779 pin; same pattern as D3-A/B's PlanningBoard
 * extractions). Canvas hands the returned object to every BoardNode via
 * BoardActionsContext so the shared ⋯ menu / maximize button can call them per-id;
 * since D4-A the command palette's selected-board verbs route through it too.
 */
import { useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { applyPush, planFullViewAction } from '../../lib/canvasDecisions'
import type { BoardActions } from '../boardActions'

export interface BoardActionsDeps {
  duplicateBoard: (id: string) => string | null
  removeBoard: (id: string) => void
  openFullView: (id: string) => void
  closeFullView: () => void
  hardCloseFullView: () => void
  enterCameraFullView: (id: string) => void
  exitCameraFullView: () => void
  fullViewIdRef: MutableRefObject<string | null>
  cameraFullViewIdRef: MutableRefObject<string | null>
  reflowAddToGroup: (groupId: string, boardIds: string[]) => void
  removeBoardFromAllGroups: (boardId: string) => void
  setFocusedId: Dispatch<SetStateAction<string | null>>
  setSelectedConnectorId: Dispatch<SetStateAction<string | null>>
  setConnectPointer: Dispatch<SetStateAction<{ x: number; y: number } | null>>
  setConnectFromId: Dispatch<SetStateAction<string | null>>
}

// Board-level actions handed to every BoardNode (via context) so the shared ⋯ menu
// / maximize button can call them per-id: Full view opens the modal layer (no camera
// move), Duplicate clones offset 36px + selects the copy, Delete parks a terminal's
// live session then removes the board (mirrors the React Flow delete path).
export function useBoardActions(deps: BoardActionsDeps): BoardActions {
  const {
    duplicateBoard,
    removeBoard,
    openFullView,
    closeFullView,
    hardCloseFullView,
    enterCameraFullView,
    exitCameraFullView,
    fullViewIdRef,
    cameraFullViewIdRef,
    reflowAddToGroup,
    removeBoardFromAllGroups,
    setFocusedId,
    setSelectedConnectorId,
    setConnectPointer,
    setConnectFromId
  } = deps

  return useMemo<BoardActions>(() => {
    return {
      // Maximize (⤢) toggles full view. Planning uses a CAMERA fit (Option A — keeps the
      // board in the canvas under one transform so add/drag stay correct); Browser/Terminal
      // use the portal modal (they need it to keep live native content alive).
      requestFullView: (id) => {
        const type = useCanvasStore.getState().boards.find((b) => b.id === id)?.type
        const steps = planFullViewAction(
          type,
          id,
          fullViewIdRef.current,
          cameraFullViewIdRef.current
        )
        for (const step of steps) {
          if (step === 'exitCameraFullView') exitCameraFullView()
          else if (step === 'enterCameraFullView') enterCameraFullView(id)
          else if (step === 'closeFullView') closeFullView()
          else openFullView(id)
        }
      },
      duplicate: (id) => {
        hardCloseFullView()
        if (cameraFullViewIdRef.current === id) exitCameraFullView()
        // Exit focus so the clone isn't born dimmed (mirrors addCentered, #14 / STATE-1).
        setFocusedId(null)
        duplicateBoard(id)
      },
      remove: (id) => {
        const removed = useCanvasStore.getState().boards.find((x) => x.id === id)
        // #BUG-015: swallow the invoke rejection (teardown/channel-gone race on a closing window)
        // so it can't surface as an unhandled promise — mirrors Canvas.tsx's memory.* guards.
        if (removed?.type === 'terminal') void window.api.parkTerminal(id).catch(() => {})
        if (fullViewIdRef.current === id) hardCloseFullView()
        if (cameraFullViewIdRef.current === id) exitCameraFullView()
        removeBoard(id)
        setFocusedId((f) => (f === id ? null : f))
      },
      pushPreviewTo: (fromBoardId, url, target) => {
        const st = useCanvasStore.getState()
        const from = st.boards.find((b) => b.id === fromBoardId)
        if (!from) return
        applyPush(
          { store: st, clearFocus: () => setFocusedId(null), hardCloseFullView },
          from,
          url,
          target
        )
      },
      // M2: begin a connector drag — arm the ephemeral gesture; the window pointer
      // listeners (Canvas effect) track the rubber-band + resolve the drop target on release.
      startConnect: (fromBoardId) => {
        setSelectedConnectorId(null)
        setConnectPointer(null)
        setConnectFromId(fromBoardId)
      },
      // S6: ⋯ menu → add this board to a group, animating the cluster re-pack.
      addToGroup: (boardId, groupId) => reflowAddToGroup(groupId, [boardId]),
      // S6: ⋯ menu → remove this board from every group it belongs to, in one undo step.
      removeFromGroup: (boardId) => removeBoardFromAllGroups(boardId)
    }
  }, [
    duplicateBoard,
    removeBoard,
    openFullView,
    closeFullView,
    hardCloseFullView,
    enterCameraFullView,
    exitCameraFullView,
    fullViewIdRef,
    cameraFullViewIdRef,
    reflowAddToGroup,
    removeBoardFromAllGroups,
    setFocusedId,
    setSelectedConnectorId,
    setConnectPointer,
    setConnectFromId
  ])
}

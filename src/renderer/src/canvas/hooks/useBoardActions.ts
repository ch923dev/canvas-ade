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
  removeBoardFromAllGroups: (boardId: string) => void
  /** Canonical camera-fit + dim focus (focusBoardById) — drives the transfer toast's Focus action. */
  focusBoardById: (id: string) => void
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
    removeBoardFromAllGroups,
    focusBoardById,
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
        // The Command board is a singleton — duplicateBoard no-ops it. Bail BEFORE the
        // full-view/focus side effects, or a no-op duplicate would silently close the user's
        // full view with nothing created (PR #175 reviewer). The ⋯ menu + palette also hide
        // the Duplicate affordance for it; this guards any remaining caller.
        if (useCanvasStore.getState().boards.find((b) => b.id === id)?.type === 'command') return
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
        if (removed?.type === 'terminal') {
          void window.api.parkTerminal(id).catch(() => {})
          // S3: drop the persisted scrollback sidecar (undo re-adopts the PARKED live session, not
          // the snapshot). Safe no-op when none exists.
          void window.api.terminal.deleteSnapshot(id).catch(() => {})
        }
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
      // GROUP-05: ⋯ menu → add this single board to a group with a PLAIN membership add (no
      // re-pack), so the board's manual position survives. The animated absorb re-pack stays on
      // the drag-onto-box gesture only (Canvas.onNodeDragStop → reflowAddToGroup).
      addToGroup: (boardId, groupId) =>
        useCanvasStore.getState().addBoardsToGroup(groupId, [boardId]),
      // GROUP-06: ⋯ menu → remove this board from ONE named group (per-membership row).
      removeFromGroup: (boardId, groupId) =>
        useCanvasStore.getState().removeBoardFromGroup(groupId, boardId),
      // GROUP-06: ⋯ menu → remove this board from every group it belongs to, in one undo step.
      removeFromAllGroups: (boardId) => removeBoardFromAllGroups(boardId),
      // Cross-board transfer toast → focus the destination board via the canonical camera path.
      focusBoard: (id) => focusBoardById(id)
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
    removeBoardFromAllGroups,
    focusBoardById,
    setFocusedId,
    setSelectedConnectorId,
    setConnectPointer,
    setConnectFromId
  ])
}

/**
 * Command-palette controller (D4-A) — owns the open/closed view state and adapts
 * Canvas's existing actions into the registry's `PaletteVerbs`. Lives beside the
 * palette (not in Canvas.tsx) so the Canvas wiring stays a few lines (779-pin).
 *
 * Ctrl+K TOGGLES: openPalette('commands') while open closes (the chord still fires
 * with the palette up — its window listener has no typing guard). `?` while open
 * switches nothing (bare keys die in the palette input's typing guard), so it only
 * ever opens from the canvas.
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { useWayfindingStore } from '../../store/wayfindingStore'
import { cameraAnim } from '../../lib/motion'
import { FIT_FRAME, RESET_FRAME, Z_MAX } from '../../lib/canvasView'
import { runBoardExport } from '../boards/planning/runExport'
import type { BoardActions } from '../boardActions'
import type { PaletteVerbs } from './commandRegistry'
import type { PaletteView } from './CommandPalette'
import { sendPaletteIntent } from './paletteIntentStore'

export interface PaletteControllerDeps {
  rf: ReactFlowInstance
  boardActions: BoardActions
  addCentered: (type: 'terminal' | 'browser' | 'planning' | 'command') => void
  selectBoard: (id: string | null) => void
  setFocusedId: (id: string | null) => void
  groupSelection: () => void
  fitGroup: (groupId: string) => void
  selectGroupMembers: (groupId: string) => void
  removeGroup: (groupId: string) => void
  tidyAndFit: () => void
  doUndo: () => void
  doRedo: () => void
}

export interface PaletteController {
  paletteView: PaletteView | null
  openPalette: (view: PaletteView) => void
  closePalette: () => void
  paletteVerbs: Omit<PaletteVerbs, 'showShortcuts'>
}

export function usePaletteController(deps: PaletteControllerDeps): PaletteController {
  const {
    rf,
    boardActions,
    addCentered,
    selectBoard,
    setFocusedId,
    groupSelection,
    fitGroup,
    selectGroupMembers,
    removeGroup,
    tidyAndFit,
    doUndo,
    doRedo
  } = deps
  const [paletteView, setPaletteView] = useState<PaletteView | null>(null)

  const openPalette = useCallback((view: PaletteView) => {
    // Ctrl+K toggles; `?` can only fire from the canvas (see header), so a plain
    // "already open → close" covers both chords without a view-flip surprise.
    setPaletteView((v) => (v === null ? view : null))
  }, [])
  const closePalette = useCallback(() => setPaletteView(null), [])

  // Mirrors Canvas's double-click focusBoard: select + frame, capping raster boards
  // (terminal/browser bitmaps blur past 100%) at zoom 1; vector planning may fill.
  const goToBoard = useCallback(
    (id: string) => {
      const board = useCanvasStore.getState().boards.find((b) => b.id === id)
      if (!board) return
      setFocusedId(id)
      selectBoard(id)
      const raster = board.type === 'terminal' || board.type === 'browser'
      void rf.fitView(cameraAnim({ padding: 0.3, maxZoom: raster ? 1 : Z_MAX, nodes: [{ id }] }))
    },
    [rf, selectBoard, setFocusedId]
  )

  // Memoised (review r1): a per-render literal would cascade through CommandPalette's
  // verbs-keyed memos and re-run buildCommands on every Canvas re-render while open.
  const paletteVerbs = useMemo<Omit<PaletteVerbs, 'showShortcuts'>>(
    () => ({
      newBoard: addCentered,
      goToBoard,
      // Rename/restart are implemented inside BoardFrame / the terminal spawn hook —
      // routed via the one-shot intent channel (sent AFTER the palette closed; the
      // palette defers run() one macrotask past onClose).
      renameBoard: (id) => sendPaletteIntent(id, 'rename'),
      restartTerminal: (id, mode) =>
        sendPaletteIntent(id, mode === 'resume' ? 'restart-resume' : 'restart-new'),
      duplicateBoard: (id) => boardActions.duplicate(id),
      deleteBoard: (id) => boardActions.remove(id),
      openFullView: (id) => boardActions.requestFullView(id),
      exportPlanning: (id, format) => {
        const board = useCanvasStore.getState().boards.find((b) => b.id === id)
        if (board?.type === 'planning') void runBoardExport(board, format)
      },
      groupSelection,
      focusGroup: (id) => {
        selectGroupMembers(id)
        fitGroup(id)
      },
      ungroup: removeGroup,
      tidy: tidyAndFit,
      fitAll: () => void rf.fitView(cameraAnim(FIT_FRAME)),
      // Recenter content at 100% rather than zoomTo(1)-in-place (#41) — same frame the
      // keymap's `0` uses.
      resetZoom: () => void rf.fitView(cameraAnim(RESET_FRAME)),
      // D4-C: same store action the bare `m` chord dispatches (wayfindingStore owns
      // the sticky visibility) — read at call time, no subscription needed here.
      toggleMinimap: () => useWayfindingStore.getState().toggleMinimap(),
      undo: doUndo,
      redo: doRedo
    }),
    [
      addCentered,
      goToBoard,
      boardActions,
      groupSelection,
      selectGroupMembers,
      fitGroup,
      removeGroup,
      tidyAndFit,
      rf,
      doUndo,
      doRedo
    ]
  )

  return { paletteView, openPalette, closePalette, paletteVerbs }
}

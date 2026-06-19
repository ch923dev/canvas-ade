/**
 * Keyboard-first board navigation (D4-B — closes audit A3/A4, the last two High a11y
 * findings). Owns the HANDLERS for the board-nav chords resolved by
 * `resolveCanvasKeyAction` (useCanvasKeybindings dispatches them — one window keydown
 * listener for the whole keymap, drift-guarded against the `?` shortcuts sheet):
 *
 * - Tab / Shift+Tab — cycle board selection in spatial reading order (y, then x), with
 *   wraparound; the camera centers on the newly selected board only when it is not
 *   already fully visible (Figma-style scroll-into-view, current zoom kept).
 * - Arrow keys — move the selected board(s) 1px (Shift = 10px). A contiguous arrow-key
 *   burst (key-repeat or rapid presses) coalesces into ONE undo step: `beginChange()` is
 *   taken only on the burst's first move, and the burst ends on arrow keyup, any
 *   non-arrow keydown, or window blur — the exact D3-C planning-nudge grammar (#119),
 *   which itself reuses the font-resize coalescing model (#94).
 * - Alt+Arrows — resize the selected board(s) by the same 1/10px steps (right/down grow,
 *   left/up shrink), clamped at MIN_BOARD_SIZE by the store. Same burst coalescing —
 *   pressing Alt itself is a non-arrow keydown, so switching move↔resize mid-hold
 *   naturally starts a fresh undo step.
 * - Enter — focus the selected board: the same camera-fit + dim-others path the
 *   double-click gesture uses (Canvas delegates onNodeDoubleClick here so the two paths
 *   can never drift). Esc already exits via the keymap's clearSelection.
 *
 * React Flow's BUILT-IN node keyboard a11y is disabled alongside this model
 * (`disableKeyboardA11y` on <ReactFlow>, wired in Canvas): its node-level arrow-move
 * calls `moveSelectedNodes` straight into onNodesChange with NO undo checkpoint — every
 * keyboard move silently merged into the previous undo step — and its node tabIndex=0
 * made Tab walk raw DOM order, not the canvas. This hook replaces both with the
 * checkpointed, spatially-ordered model.
 *
 * Every returned callback is IDENTITY-STABLE (all state read via getState()/refs): they
 * are deps of useCanvasKeybindings' window-keydown effect, so an identity change there
 * would re-register the listener mid-dispatch (the D1-B/C removal class). The burst
 * lifecycle listeners below are likewise registered once and read only refs.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import type { Board } from '../../lib/boardSchema'
import { cameraAnim } from '../../lib/motion'
import { Z_MAX, focusMaxZoom } from '../../lib/canvasView'

/** Single-board focus framing (DESIGN.md §5/§9: ~70px pad), shared by Enter and
 *  double-click. Animated via `cameraAnim`. (Moved verbatim from Canvas.tsx.) */
const FOCUS_OPTIONS = { padding: 0.3, maxZoom: Z_MAX } as const

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/**
 * Pure: the Tab-cycle order — spatial reading order (top-to-bottom, then
 * left-to-right), id as the determinism tiebreaker for coincident origins.
 */
export function cycleOrder(boards: readonly Board[]): Board[] {
  return [...boards].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
}

/**
 * Pure: the next board id for a Tab cycle. With nothing selected, Tab enters the cycle
 * at the first board (Shift+Tab at the last); otherwise step `dir` with wraparound.
 * `currentId` not found (stale selection) re-enters like the empty case.
 */
export function nextBoardId(
  boards: readonly Board[],
  currentId: string | null,
  dir: 1 | -1
): string | null {
  if (boards.length === 0) return null
  const order = cycleOrder(boards)
  const cur = currentId === null ? -1 : order.findIndex((b) => b.id === currentId)
  if (cur === -1) return order[dir === 1 ? 0 : order.length - 1].id
  return order[(cur + dir + order.length) % order.length].id
}

export interface BoardKeyboardNavDeps {
  rf: ReactFlowInstance
  paneRef: React.RefObject<HTMLDivElement | null>
  /** Canvas's focus-mode state (camera fitted, others dimmed). */
  setFocusedId: Dispatch<SetStateAction<string | null>>
}

export interface BoardKeyboardNavApi {
  /** Tab/Shift+Tab handler — returns true when a board was selected (key consumed). */
  cycleBoard: (dir: 1 | -1) => boolean
  /** Arrow handler — returns true when a non-empty selection was moved. */
  moveSelectedBoards: (dx: number, dy: number) => boolean
  /** Alt+Arrow handler — returns true when a non-empty selection was resized. */
  resizeSelectedBoards: (dw: number, dh: number) => boolean
  /** Enter handler — returns true when a selected board was camera-focused. */
  focusSelectedBoard: () => boolean
  /** The double-click/Enter focus path: camera-fit one board + dim the others. */
  focusBoardById: (id: string) => void
}

export function useBoardKeyboardNav(deps: BoardKeyboardNavDeps): BoardKeyboardNavApi {
  const { rf, paneRef, setFocusedId } = deps

  // True while an arrow-key burst is in flight: the first move/resize of a burst takes
  // the (lazy, #BUG-004) undo checkpoint; every further one in the same burst commits
  // without one, so the whole burst undoes as a single step back to the pre-burst state.
  const nudging = useRef(false)

  // Burst lifecycle: arrow keyup or any non-arrow keydown ends the burst (so e.g.
  // nudge → Ctrl+Z → nudge takes a FRESH checkpoint for the second burst — pressing
  // Ctrl is itself a non-arrow keydown); window blur ends it too (the OS swallows the
  // keyup on alt-tab). Registered ONCE; reads only the ref (mid-dispatch class).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!ARROW_KEYS.has(e.key)) nudging.current = false
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (ARROW_KEYS.has(e.key)) nudging.current = false
    }
    const onBlur = (): void => {
      nudging.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  /** Center the camera on a board (current zoom, §9 motion) unless it is already fully
   *  visible in the pane — Tab must always land the ring somewhere the user can see. */
  const ensureVisible = useCallback(
    (board: Board): void => {
      const pane = paneRef.current
      if (!pane) return
      const r = pane.getBoundingClientRect()
      const tl = rf.flowToScreenPosition({ x: board.x, y: board.y })
      const br = rf.flowToScreenPosition({ x: board.x + board.w, y: board.y + board.h })
      const fullyVisible = tl.x >= r.left && tl.y >= r.top && br.x <= r.right && br.y <= r.bottom
      if (fullyVisible) return
      void rf.setCenter(
        board.x + board.w / 2,
        board.y + board.h / 2,
        cameraAnim({ zoom: rf.getViewport().zoom })
      )
    },
    [rf, paneRef]
  )

  const cycleBoard = useCallback(
    (dir: 1 | -1): boolean => {
      const s = useCanvasStore.getState()
      const nextId = nextBoardId(s.boards, s.selectedId, dir)
      if (nextId === null) return false
      // Exit focus mode: Tab moves the selection, so a camera-fit + dim still keyed on
      // the PREVIOUS board would show a stale visual (ring on B, dim centred on A).
      // No-op (same-value setState) when not in focus mode.
      setFocusedId(null)
      s.selectBoard(nextId)
      const next = s.boards.find((b) => b.id === nextId)
      if (next) ensureVisible(next)
      return true
    },
    [ensureVisible, setFocusedId]
  )

  const moveSelectedBoards = useCallback((dx: number, dy: number): boolean => {
    const s = useCanvasStore.getState()
    const ids = s.selectedIds
    if (ids.length === 0) return false
    if (!nudging.current) {
      s.beginChange()
      nudging.current = true
    }
    // Live-read each board at commit time (not a render closure): key-repeat lands
    // rapid commits and each must chain off the previous position (BUG-023 class).
    for (const id of ids) {
      const b = useCanvasStore.getState().boards.find((x) => x.id === id)
      if (b) s.updateBoard(id, { x: b.x + dx, y: b.y + dy })
    }
    return true
  }, [])

  const resizeSelectedBoards = useCallback((dw: number, dh: number): boolean => {
    const s = useCanvasStore.getState()
    const ids = s.selectedIds
    if (ids.length === 0) return false
    if (!nudging.current) {
      s.beginChange()
      nudging.current = true
    }
    for (const id of ids) {
      const b = useCanvasStore.getState().boards.find((x) => x.id === id)
      // resizeBoard clamps at MIN_BOARD_SIZE and no-ops a clamped-to-same resize, so a
      // burst pinned at the minimum pushes no phantom undo step.
      if (b) s.resizeBoard(id, b.w + dw, b.h + dh)
    }
    return true
  }, [])

  const focusBoardById = useCallback(
    (id: string): void => {
      const board = useCanvasStore.getState().boards.find((b) => b.id === id)
      if (!board) return
      setFocusedId(id)
      useCanvasStore.getState().selectBoard(id)
      // Terminal/browser content is a raster bitmap (xterm WebGL/canvas, OSR snapshot) that the
      // camera transform UPSCALES past 100% → blurry text, so their focus zoom caps at 1; vector
      // boards (planning notes/pen/diagram) re-rasterize sharp at any zoom and may fill the
      // viewport (Z_MAX). The raster-vs-vector rule lives in focusMaxZoom (CANVAS-04), shared
      // with useFullView's camera full view so the two can't drift.
      void rf.fitView(
        cameraAnim({ ...FOCUS_OPTIONS, maxZoom: focusMaxZoom(board.type), nodes: [{ id }] })
      )
    },
    [rf, setFocusedId]
  )

  const focusSelectedBoard = useCallback((): boolean => {
    const id = useCanvasStore.getState().selectedId
    if (!id) return false
    focusBoardById(id)
    return true
  }, [focusBoardById])

  return {
    cycleBoard,
    moveSelectedBoards,
    resizeSelectedBoards,
    focusSelectedBoard,
    focusBoardById
  }
}

/**
 * React Flow custom node = one board (ADR 0001: each board is a custom RF node).
 * Owns the cross-type concerns — zoom-driven LOD card, the restyled `NodeResizer`,
 * hover state, and the focus-dim — then dispatches the full-detail render to the
 * per-type board component, which fills the `BoardFrame` content slot + actions.
 *
 * The dispatch seam is FROZEN for the parallel board work (2.1/2.2/2.3): each
 * board type owns exactly one file under `canvas/boards/`. Do not collapse the
 * dispatch back into this file.
 */
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { createPortal } from 'react-dom'
import { NodeResizer, useStore, Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Board } from '../lib/boardSchema'
import { BoardActionsContext } from './boardActions'
import type { ResolvedPushTarget } from '../lib/previewTarget'
import { BoardFullViewContext, FullViewContext } from './fullViewContext'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import { boardStatusBucket, bucketToPill } from '../store/boardStatus'
import { MIN_BOARD_SIZE } from '../lib/boardSchema'
import { isLod } from '../lib/canvasView'
import { BoardFrame } from './BoardFrame'

// §F code-split: each board type is its own lazy chunk so its heavy deps load only
// when a board of that type first mounts — a no-terminal project never fetches xterm
// (TerminalBoard chunk), a no-planning project never fetches the pen/freehand code.
// The boards keep stable identity once loaded (React.lazy caches the module), so the
// createPortal relocation that keeps the live PTY/native view alive is unaffected.
const TerminalBoard = lazy(() =>
  import('./boards/TerminalBoard').then((m) => ({ default: m.TerminalBoard }))
)
const BrowserBoard = lazy(() =>
  import('./boards/BrowserBoard').then((m) => ({ default: m.BrowserBoard }))
)
const PlanningBoard = lazy(() =>
  import('./boards/PlanningBoard').then((m) => ({ default: m.PlanningBoard }))
)

/** Hidden, non-connectable anchor handles so RF can attach the preview edge to any
 *  board without exposing a connection UX or stealing pointer events (Slice C′). */
const HIDDEN_HANDLE = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 'none',
  background: 'transparent',
  pointerEvents: 'none' as const
}
function EdgeAnchors(): ReactElement {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
    </>
  )
}

export interface BoardNodeData extends Record<string, unknown> {
  board: Board
  /** Dim to 55% when another board is focused (dimOnFocus, fixed-on). */
  dimmed?: boolean
  /** This board is the one shown in the full-view modal (Task 6 portals it). */
  fullView?: boolean
}

export type BoardFlowNode = Node<BoardNodeData, 'board'>

/** Per-type shared props every board component receives from the node. */
export interface BoardViewProps<T extends Board = Board> {
  board: T
  selected: boolean
  hovered: boolean
  dimmed: boolean
  /**
   * Camera is below `LOD_ZOOM` → the board should render its compact LOD card.
   * Only TerminalBoard reads this: it stays MOUNTED at LOD (hides the xterm host,
   * shows the card) so the live PTY/agent session survives zoom-out. The other
   * board types never receive it — BoardNode renders their LOD card itself.
   */
  lod?: boolean
  /**
   * This board is shown in the full-view modal (its subtree is portaled there).
   * BrowserBoard reads it to fill the modal with its device frame instead of the
   * board-geometry-sized frame, so the native view (bound to the frame's DOM rect)
   * renders edge-to-edge.
   */
  fullView?: boolean
  /** Title-bar maximize → request full view for this board. */
  onFull?: () => void
  /** ⋯ menu → duplicate this board. */
  onDuplicate?: () => void
  /** ⋯ menu → delete this board (terminal park-on-delete handled by the store/Canvas). */
  onDelete?: () => void
  /** S6 ⋯ menu → add this board to a group (the absorb re-pack). */
  onAddToGroup?: (groupId: string) => void
  /** S6 ⋯ menu → remove this board from every group it belongs to. */
  onRemoveFromGroup?: () => void
  /** Terminal "Preview" action → push `url` to a chosen Browser target (refresh linked,
   *  connect, re-target, or spawn). Target chosen by gesture + the multi-select picker. */
  onPushPreviewTo?: (url: string, target: ResolvedPushTarget) => void
  /** M2: title-bar connector handle → begin a connector drag from this board. */
  onStartConnect?: () => void
}

export function BoardNode({ data, selected = false }: NodeProps<BoardFlowNode>): ReactElement {
  const board = data.board
  // T1.6: the LOD card's status dot is derived from the SAME bucket the MCP sees
  // (boardStatusBucket over the live terminal/preview stores), so the zoomed-out dot
  // and the agent's canvas://boards view never disagree. (The old type-only dot lied —
  // a browser always read green, ignoring load-failed.) Terminals keep their own rich
  // pill in TerminalBoard; this LOD path is taken only by browser/planning boards.
  const termRunning = useTerminalRuntimeStore((s) => !!s.running[board.id])
  const previewStatus = usePreviewStore((s) => s.byId[board.id]?.status)
  const lodPill = bucketToPill(
    boardStatusBucket(board.type, { terminalRunning: termRunning, preview: previewStatus })
  )
  // Subscribe to the derived LOD boolean, NOT the raw zoom scalar: with Object.is
  // equality the selected value only flips at the LOD threshold, so a BoardNode
  // re-renders only at the crossover instead of on every intra-band zoom frame (#39).
  const lod = useStore((s) => isLod(s.transform[2]))
  const [hovered, setHovered] = useState(false)
  const dimmed = data.dimmed ?? false
  const acts = useContext(BoardActionsContext)
  const fullViewHost = useContext(FullViewContext)
  const fullView = data.fullView ?? false
  const onFull = acts ? (): void => acts.requestFullView(board.id) : undefined
  const onDuplicate = acts ? (): void => acts.duplicate(board.id) : undefined
  const onDelete = acts ? (): void => acts.remove(board.id) : undefined
  const onAddToGroup = acts
    ? (groupId: string): void => acts.addToGroup(board.id, groupId)
    : undefined
  const onRemoveFromGroup = acts ? (): void => acts.removeFromGroup(board.id) : undefined
  const onPushPreviewTo = acts
    ? (url: string, target: ResolvedPushTarget): void => acts.pushPreviewTo(board.id, url, target)
    : undefined
  const onStartConnect = acts ? (): void => acts.startConnect(board.id) : undefined
  const actions = {
    onFull,
    onDuplicate,
    onDelete,
    onAddToGroup,
    onRemoveFromGroup,
    onPushPreviewTo,
    onStartConnect
  }

  // The hover div lives only in the full-chrome render; the LOD card (non-terminal)
  // unmounts it. Unmounting under a stationary cursor fires no mouseLeave, so hover
  // would stay armed across the LOD boundary and paint a stale border + resize
  // handles on zoom-in. Clear it on LOD entry — but ONLY for the types that take the
  // LOD early-return below; terminal boards stay full-chrome at LOD (their hover div
  // never unmounts), so they have no stale-hover bug and must keep normal hover
  // behavior (#BUG-017, scoped per the card to non-terminal boards).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (lod && board.type !== 'terminal') setHovered(false)
  }, [lod, board.type])

  // Stable per-board content host: created ONCE and always the createPortal target, so
  // toggling full view never changes the fiber structure (which would remount the subtree
  // and kill a live PTY — bug 1). We RELOCATE this element in the DOM between the in-node
  // anchor and the modal host; React keeps rendering into the same node, so no remount.
  // Declared BEFORE the LOD early-return so these hooks run on EVERY render path
  // (rules-of-hooks); in the LOD early-return path anchorRef is null so the effect no-ops.
  // useState (not useRef) so the host element is created render-safe and stable, and the
  // portal target is read from a value, not a ref during render (react-hooks/refs).
  const [contentHost] = useState<HTMLDivElement>(() => {
    const d = document.createElement('div')
    d.style.position = 'absolute'
    d.style.inset = '0'
    return d
  })
  const anchorRef = useRef<HTMLDivElement>(null)

  // `lod` is a dep because a non-terminal board UNMOUNTS its anchor on the LOD early-
  // return below; when it returns to detail the anchor is a NEW element, so the effect
  // must re-run to re-append contentHost — else the board's content stays orphaned
  // (detached from the DOM) after a zoom-out→in and the board renders blank.
  useLayoutEffect(() => {
    const target = fullView && fullViewHost ? fullViewHost : anchorRef.current
    if (target && contentHost.parentNode !== target) target.appendChild(contentHost)
  }, [contentHost, fullView, fullViewHost, lod])

  // Terminal boards stay MOUNTED across the LOD boundary so the live PTY/agent
  // session survives zoom-out (the xterm/MessagePort/PTY would die on unmount).
  // TerminalBoard reads `lod` and swaps the xterm host for its own LOD card while
  // keeping the session alive. Other types are presentational at LOD — BoardNode
  // renders their static LOD card and unmounts the heavy content.
  //
  // EXCEPTION: a board in full view ALWAYS renders its real content (never the LOD
  // card), even when the camera is zoomed out below LOD. The full-view board is
  // portaled into the (untransformed) modal host, so its real `.bb-frame` must exist
  // there for `fullViewBoundsFor` to read the modal rect; the LOD card has no
  // `.bb-frame` and never portals, which would strand the native view at its
  // camera-scaled canvas position (the full-view native-bounds bug).
  if (lod && board.type !== 'terminal' && !fullView) {
    return (
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <EdgeAnchors />
        <BoardFrame
          type={board.type}
          title={board.title}
          selected={selected}
          dimmed={dimmed}
          lod
          status={lodPill}
        />
      </div>
    )
  }

  const common = { selected, hovered, dimmed }
  // Provide this board's full-view flag to its whole subtree so every board type's
  // BoardFrame lights the title-bar EXIT affordance when this board is the one in the
  // modal — without threading a `fullView` prop through each per-type board (only
  // BrowserBoard reads the prop, for its native-view re-bind). Context drives the chrome.
  const subtree = (
    <BoardFullViewContext.Provider value={fullView}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ position: 'absolute', inset: 0 }}
      >
        {/* fallback=null: the brief gap before a board's chunk resolves on first mount.
            The board renders its own BoardFrame chrome once loaded; subsequent mounts
            are synchronous (module cached). */}
        <Suspense fallback={null}>
          <ErrorBoundary
            fallback={
              <div className="board-error" style={{ padding: 16, color: 'var(--text-2)' }}>
                This board failed to render
              </div>
            }
          >
            {board.type === 'terminal' && (
              <TerminalBoard board={board} lod={lod} {...common} {...actions} />
            )}
            {board.type === 'browser' && (
              <BrowserBoard board={board} {...common} {...actions} fullView={fullView} />
            )}
            {board.type === 'planning' && <PlanningBoard board={board} {...common} {...actions} />}
          </ErrorBoundary>
        </Suspense>
      </div>
    </BoardFullViewContext.Provider>
  )

  return (
    <>
      <EdgeAnchors />
      {/* Hidden in LOD: the design shows no resize handles on LOD cards. */}
      {!lod && (
        <NodeResizer
          minWidth={MIN_BOARD_SIZE.w}
          minHeight={MIN_BOARD_SIZE.h}
          isVisible={selected || hovered}
          // Checkpoint for undo on press. Arm the gesture flag (so the preview layer
          // detaches live native views, which can't be clipped, to snapshots while
          // this board resizes) only on the FIRST real movement — XYResizer fires
          // onResizeStart on a pure handle click too, and onResizeEnd is gated on
          // movement, so arming on start would leave nodeGesture stuck true (#BUG-003).
          onResizeStart={() => {
            useCanvasStore.getState().beginChange()
          }}
          onResize={() => {
            usePreviewStore.getState().setNodeGesture(true)
            // Pull live native views out IMMEDIATELY (mirrors onNodeDragStart): the async
            // beginMotion snapshot lags the first resize frames, during which flushBatch
            // repositions an always-above native layer that can ghost at the old size
            // (PREV-B / #43961). Idempotent; reattach happens on resize end.
            void window.api.detachAllPreviews?.()
          }}
          onResizeEnd={() => usePreviewStore.getState().setNodeGesture(false)}
        />
      )}
      {/* In-node mount point; the stable content host is appended here when not full-view. */}
      <div ref={anchorRef} style={{ position: 'absolute', inset: 0 }} />
      {createPortal(subtree, contentHost)}
    </>
  )
}

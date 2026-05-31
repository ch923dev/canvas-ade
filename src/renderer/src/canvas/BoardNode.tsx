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
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useStore, Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Board, BoardType } from '../lib/boardSchema'
import { BoardActionsContext } from './boardActions'
import { FullViewContext } from './fullViewContext'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { MIN_BOARD_SIZE } from '../lib/boardSchema'
import { isLod } from '../lib/canvasView'
import { BoardFrame, type BoardStatus } from './BoardFrame'
import { TerminalBoard } from './boards/TerminalBoard'
import { BrowserBoard } from './boards/BrowserBoard'
import { PlanningBoard } from './boards/PlanningBoard'

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
  /** Terminal "Preview" action → open/point a linked Browser board at `url`. */
  onPushPreview?: (url: string) => void
}

/** Status dot shown on the LOD card (no label at LOD). */
function lodStatus(type: BoardType): BoardStatus | null {
  if (type === 'terminal') return { dot: 'var(--text-3)' }
  if (type === 'browser') return { dot: 'var(--ok)' }
  return null
}

export function BoardNode({ data, selected = false }: NodeProps<BoardFlowNode>): ReactElement {
  const board = data.board
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
  const onPushPreview = acts ? (url: string): void => acts.pushPreview(board.id, url) : undefined
  const actions = { onFull, onDuplicate, onDelete, onPushPreview }

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
          status={lodStatus(board.type)}
        />
      </div>
    )
  }

  // Stable per-board content host: created ONCE and always the createPortal target, so
  // toggling full view never changes the fiber structure (which would remount the subtree
  // and kill a live PTY — bug 1). We RELOCATE this element in the DOM between the in-node
  // anchor and the modal host; React keeps rendering into the same node, so no remount.
  const contentHostRef = useRef<HTMLDivElement | null>(null)
  if (!contentHostRef.current) {
    const d = document.createElement('div')
    d.style.position = 'absolute'
    d.style.inset = '0'
    contentHostRef.current = d
  }
  const anchorRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = contentHostRef.current
    if (!host) return
    const target = fullView && fullViewHost ? fullViewHost : anchorRef.current
    if (target && host.parentNode !== target) target.appendChild(host)
  }, [fullView, fullViewHost])

  const common = { selected, hovered, dimmed }
  const subtree = (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'absolute', inset: 0 }}
    >
      {board.type === 'terminal' && (
        <TerminalBoard board={board} lod={lod} {...common} {...actions} />
      )}
      {board.type === 'browser' && (
        <BrowserBoard board={board} {...common} {...actions} fullView={fullView} />
      )}
      {board.type === 'planning' && <PlanningBoard board={board} {...common} {...actions} />}
    </div>
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
          onResize={() => usePreviewStore.getState().setNodeGesture(true)}
          onResizeEnd={() => usePreviewStore.getState().setNodeGesture(false)}
        />
      )}
      {/* In-node mount point; the stable content host is appended here when not full-view. */}
      <div ref={anchorRef} style={{ position: 'absolute', inset: 0 }} />
      {createPortal(subtree, contentHostRef.current)}
    </>
  )
}

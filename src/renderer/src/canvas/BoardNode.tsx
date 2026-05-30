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
import { useState, type ReactElement } from 'react'
import { NodeResizer, useStore, type Node, type NodeProps } from '@xyflow/react'
import type { Board, BoardType } from '../lib/boardSchema'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { MIN_BOARD_SIZE } from '../lib/boardSchema'
import { isLod } from '../lib/canvasView'
import { BoardFrame, type BoardStatus } from './BoardFrame'
import { TerminalBoard } from './boards/TerminalBoard'
import { BrowserBoard } from './boards/BrowserBoard'
import { PlanningBoard } from './boards/PlanningBoard'

export interface BoardNodeData extends Record<string, unknown> {
  board: Board
  /** Dim to 55% when another board is focused (dimOnFocus, fixed-on). */
  dimmed?: boolean
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

  // Terminal boards stay MOUNTED across the LOD boundary so the live PTY/agent
  // session survives zoom-out (the xterm/MessagePort/PTY would die on unmount).
  // TerminalBoard reads `lod` and swaps the xterm host for its own LOD card while
  // keeping the session alive. Other types are presentational at LOD — BoardNode
  // renders their static LOD card and unmounts the heavy content.
  if (lod && board.type !== 'terminal') {
    return (
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
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

  const common = { selected, hovered, dimmed }
  return (
    <>
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
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ position: 'absolute', inset: 0 }}
      >
        {board.type === 'terminal' && <TerminalBoard board={board} lod={lod} {...common} />}
        {board.type === 'browser' && <BrowserBoard board={board} {...common} />}
        {board.type === 'planning' && <PlanningBoard board={board} {...common} />}
      </div>
    </>
  )
}

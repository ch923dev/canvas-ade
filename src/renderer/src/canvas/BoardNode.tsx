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
}

/** Status dot shown on the LOD card (no label at LOD). */
function lodStatus(type: BoardType): BoardStatus | null {
  if (type === 'terminal') return { dot: 'var(--text-3)' }
  if (type === 'browser') return { dot: 'var(--ok)' }
  return null
}

export function BoardNode({ data, selected = false }: NodeProps<BoardFlowNode>): ReactElement {
  const board = data.board
  const zoom = useStore((s) => s.transform[2])
  const lod = isLod(zoom)
  const [hovered, setHovered] = useState(false)
  const dimmed = data.dimmed ?? false

  if (lod) {
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
      <NodeResizer
        minWidth={MIN_BOARD_SIZE.w}
        minHeight={MIN_BOARD_SIZE.h}
        isVisible={selected || hovered}
        onResizeStart={() => useCanvasStore.getState().beginChange()}
      />
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ position: 'absolute', inset: 0 }}
      >
        {board.type === 'terminal' && <TerminalBoard board={board} {...common} />}
        {board.type === 'browser' && <BrowserBoard board={board} {...common} />}
        {board.type === 'planning' && <PlanningBoard board={board} {...common} />}
      </div>
    </>
  )
}

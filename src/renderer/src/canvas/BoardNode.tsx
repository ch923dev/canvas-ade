/**
 * React Flow custom node = one board (ADR 0001: each board is a custom RF node).
 * Wraps the shared `BoardFrame`, swaps to the LOD card below `LOD_ZOOM`, and hosts
 * a restyled `NodeResizer` (visible on hover/selection, hidden in LOD). Content is
 * a per-type placeholder in 2.0-C — the real Terminal/Browser/Planning content
 * lands in 2.1 / 2.2 / 2.3, which only replace the children of this frame.
 */
import { useState, type ReactElement } from 'react'
import { NodeResizer, useStore, type Node, type NodeProps } from '@xyflow/react'
import type { Board, BoardType } from '../lib/boardSchema'
import { MIN_BOARD_SIZE } from '../lib/boardSchema'
import { isLod } from '../lib/canvasView'
import { BoardFrame, type BoardStatus } from './BoardFrame'
import { TypeGlyph } from './TypeGlyph'

export interface BoardNodeData extends Record<string, unknown> {
  board: Board
  /** Dim to 55% when another board is focused (dimOnFocus, fixed-on). */
  dimmed?: boolean
}

export type BoardFlowNode = Node<BoardNodeData, 'board'>

const PLACEHOLDER_LABEL: Record<BoardType, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  planning: 'Planning'
}

const PLACEHOLDER_PHASE: Record<BoardType, string> = {
  terminal: '2.1',
  browser: '2.2',
  planning: '2.3'
}

/** Static placeholder content per type (real content arrives in 2.1–2.3). */
function PlaceholderContent({ type }: { type: BoardType }): ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8
      }}
    >
      <div style={{ transform: 'scale(1.8)', color: 'var(--text-3)' }}>
        <TypeGlyph type={type} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)' }}>
        {PLACEHOLDER_LABEL[type]} board
      </div>
      <div className="t-meta" style={{ color: 'var(--text-faint)' }}>
        content · Phase {PLACEHOLDER_PHASE[type]}
      </div>
    </div>
  )
}

function statusFor(type: BoardType): BoardStatus | null {
  if (type === 'terminal') return { dot: 'var(--text-3)', label: 'idle' }
  if (type === 'browser') return { dot: 'var(--ok)', label: 'preview' }
  return null
}

export function BoardNode({ data, selected = false }: NodeProps<BoardFlowNode>): ReactElement {
  const board = data.board
  const zoom = useStore((s) => s.transform[2])
  const lod = isLod(zoom)
  const [hovered, setHovered] = useState(false)

  const showResizer = (selected || hovered) && !lod

  return (
    <>
      {showResizer && (
        <NodeResizer minWidth={MIN_BOARD_SIZE.w} minHeight={MIN_BOARD_SIZE.h} lineClassName="" />
      )}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ position: 'absolute', inset: 0, pointerEvents: lod ? 'none' : 'auto' }}
      >
        <BoardFrame
          type={board.type}
          title={board.title}
          selected={selected}
          hovered={hovered}
          dimmed={data.dimmed}
          lod={lod}
          status={statusFor(board.type)}
          contentBg={board.type === 'terminal' ? 'var(--inset)' : 'var(--surface)'}
        >
          {!lod && <PlaceholderContent type={board.type} />}
        </BoardFrame>
      </div>
    </>
  )
}

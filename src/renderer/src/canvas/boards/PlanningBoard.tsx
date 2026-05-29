/**
 * Planning board content (Phase 2.3). STUB — renders the shared `BoardFrame` with
 * placeholder content. 2.3 replaces it with the whiteboard layer: sticky notes,
 * free text, SVG-bezier arrows, freehand pen (vendored perfect-freehand, pointer
 * deltas ÷ zoom), and the Checklist element + the selected-only tool cluster
 * (DESIGN.md §7.3). Owns this file only; the shared surface is frozen.
 */
import type { ReactElement } from 'react'
import type { PlanningBoard as PlanningBoardData } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import { TypeGlyph } from '../TypeGlyph'
import type { BoardViewProps } from '../BoardNode'

export function PlanningBoard({
  board,
  selected,
  hovered,
  dimmed
}: BoardViewProps<PlanningBoardData>): ReactElement {
  return (
    <BoardFrame
      type="planning"
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      status={null}
      contentBg="var(--surface)"
    >
      <div style={placeholder}>
        <div style={{ transform: 'scale(1.8)', color: 'var(--text-3)' }}>
          <TypeGlyph type="planning" />
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)' }}>Planning board</div>
        <div className="t-meta" style={{ color: 'var(--text-faint)' }}>
          content · Phase 2.3
        </div>
      </div>
    </BoardFrame>
  )
}

const placeholder: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8
}

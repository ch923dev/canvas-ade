/**
 * Browser board content (Phase 2.2). STUB — renders the shared `BoardFrame` with
 * placeholder content. 2.2 replaces it with the real preview over the PreviewManager
 * (extracted from `smoke/FlowSmoke.tsx`): viewport segmented control, HTML device
 * frame around the unrounded native rect, URL/route bar, nav IPC (DESIGN.md §7.2).
 * Owns this file only; the shared surface (BoardFrame/schema/store) is frozen.
 */
import type { ReactElement } from 'react'
import type { BrowserBoard as BrowserBoardData } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import { TypeGlyph } from '../TypeGlyph'
import type { BoardViewProps } from '../BoardNode'

export function BrowserBoard({
  board,
  selected,
  hovered,
  dimmed
}: BoardViewProps<BrowserBoardData>): ReactElement {
  return (
    <BoardFrame
      type="browser"
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      status={{ dot: 'var(--ok)', label: 'preview' }}
      contentBg="var(--surface)"
    >
      <div style={placeholder}>
        <div style={{ transform: 'scale(1.8)', color: 'var(--text-3)' }}>
          <TypeGlyph type="browser" />
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)' }}>Browser board</div>
        <div className="t-meta" style={{ color: 'var(--text-faint)' }}>
          content · Phase 2.2
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

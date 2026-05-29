/**
 * Terminal board content (Phase 2.1). STUB — renders the shared `BoardFrame` with
 * placeholder content. 2.1 replaces the content slot with a live xterm instance
 * bridged to `node-pty` over the MessagePort, the agent identity pill + run timer,
 * progress sliver, and the follow-up prompt (DESIGN.md §7.1). Owns this file only;
 * the shared surface (BoardFrame/schema/store) is frozen.
 */
import type { ReactElement } from 'react'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import { TypeGlyph } from '../TypeGlyph'
import type { BoardViewProps } from '../BoardNode'

export function TerminalBoard({
  board,
  selected,
  hovered,
  dimmed
}: BoardViewProps<TerminalBoardData>): ReactElement {
  return (
    <BoardFrame
      type="terminal"
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      status={{ dot: 'var(--text-3)', label: 'idle' }}
      contentBg="var(--inset)"
    >
      <div style={placeholder}>
        <div style={{ transform: 'scale(1.8)', color: 'var(--text-3)' }}>
          <TypeGlyph type="terminal" />
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)' }}>Terminal board</div>
        <div className="t-meta" style={{ color: 'var(--text-faint)' }}>
          content · Phase 2.1
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

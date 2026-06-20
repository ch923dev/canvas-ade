/**
 * The Planning board's tool cluster (BoardFrame action slot, selected-only):
 * `select · note · text · check · arrow · pen · erase`, the snap toggle, and the
 * export popover. A verbatim move out of `PlanningBoard.tsx` (D3-B, max-lines
 * ratchet) — the board owns the tool/snap state and threads it in; this file is
 * presentation only.
 */
import type { ReactElement } from 'react'
import type { PlanningBoard as PlanningBoardData } from '../../../lib/boardSchema'
import { IconBtn } from '../../BoardFrame'
import { ExportPopover } from './ExportPopover'
import { TOOL_META, type PlanTool } from './tools'

const TOOLS: ReadonlyArray<{
  tool: PlanTool
  icon: 'select' | 'note' | 'text' | 'check' | 'arrow' | 'pen' | 'erase' | 'diagram'
}> = [
  { tool: 'select', icon: 'select' },
  { tool: 'note', icon: 'note' },
  { tool: 'text', icon: 'text' },
  { tool: 'check', icon: 'check' },
  { tool: 'diagram', icon: 'diagram' },
  { tool: 'arrow', icon: 'arrow' },
  { tool: 'pen', icon: 'pen' },
  { tool: 'erase', icon: 'erase' }
]

export interface PlanningToolbarProps {
  board: PlanningBoardData
  tool: PlanTool
  snapEnabled: boolean
  /** Pick a tool (the board also clears the selection on a switch). */
  onPickTool: (tool: PlanTool) => void
  onToggleSnap: () => void
}

export function PlanningToolbar({
  board,
  tool,
  snapEnabled,
  onPickTool,
  onToggleSnap
}: PlanningToolbarProps): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: 2,
        background: 'var(--inset)',
        borderRadius: 'var(--r-inner)',
        border: '1px solid var(--border-subtle)',
        marginRight: 2
      }}
      // Keep tool clicks from starting the title-bar drag.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TOOLS.map(({ tool: t, icon }) => {
        // PLAN-02 (a11y): a human accessible name ("Sticky note", "Eraser") instead of the
        // bare tool id, via PA-2's IconBtn `ariaLabel`. PLAN-03: the tooltip surfaces the
        // keyboard shortcut letter, e.g. "Sticky note (N)". `toggle` makes the active tool
        // announce aria-pressed (it signalled active by glyph color alone before).
        const meta = TOOL_META[t]
        return (
          <IconBtn
            key={t}
            name={icon}
            title={`${meta.label} (${meta.key.toUpperCase()})`}
            ariaLabel={meta.label}
            toggle
            size={15}
            active={tool === t}
            onClick={() => onPickTool(t)}
          />
        )
      })}
      <div
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: 'var(--border-subtle)',
          margin: '0 2px'
        }}
      />
      <IconBtn
        name="magnet"
        title={snapEnabled ? 'Snapping on' : 'Snapping off'}
        ariaLabel="Snap to grid"
        toggle
        size={15}
        active={snapEnabled}
        onClick={onToggleSnap}
      />
      <div
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: 'var(--border-subtle)',
          margin: '0 2px'
        }}
      />
      <ExportPopover board={board} />
    </div>
  )
}

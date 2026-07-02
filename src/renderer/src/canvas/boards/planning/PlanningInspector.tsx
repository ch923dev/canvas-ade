/**
 * PlanningInspector (P3) — the Planning board's per-type content for the Board Inspector. The
 * whiteboard tool palette + snap + export, MOVED off the on-board title-bar action slot into the
 * docked popover (the 2026-06-26 sign-off; the on-board PlanningToolbar is deleted). Presentation
 * only: PlanningBoard owns the tool/snap state and threads its EXACT existing handlers in, so
 * picking a tool here is identical to pressing its bare-letter shortcut — which stays the always-on
 * fast path. onPickTool calls setTool + clears the ELEMENT selection (never the board's selection),
 * so the Inspector stays revealed through a whole draw session.
 *
 * Layout (signed off 2026-07-01): the 8 tools as a compact 4×2 icon grid (.ca-inspector-toolgrid —
 * the one new CSS block), active tool accent-washed with its shortcut letter in the corner; then a
 * Canvas section with the snap InspectorToggle + an Export action that opens the shipped
 * ExportPopover (PNG/SVG). The shell owns the head (glyph/type/title/jump) + the Duplicate foot.
 */
import type { ReactElement } from 'react'
import type { PlanningBoard as PlanningBoardData } from '../../../lib/boardSchema'
import { Icon } from '../../Icon'
import { InspectorRow, InspectorSection, InspectorToggle } from '../../inspector/primitives'
import { inspectorRadioGroupKeyDown } from '../../inspector/radioGroup'
import { ExportPopover } from './ExportPopover'
import { ElementInspectorSection } from './inspector/ElementInspectorSection'
import type { ElementInspectorModel } from './inspector/usePlanningElementInspector'
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

export interface PlanningInspectorProps {
  board: PlanningBoardData
  tool: PlanTool
  snapEnabled: boolean
  /** The selected element(s) model (P4) — the inspector grows an Element section at the top when an
   *  element is selected in select mode; null otherwise (baseline P3 = Tools + Canvas only). */
  element: ElementInspectorModel | null
  /** Pick a tool (the board also clears the element selection on a switch — never the board). */
  onPickTool: (tool: PlanTool) => void
  onToggleSnap: () => void
}

export function PlanningInspector({
  board,
  tool,
  snapEnabled,
  element,
  onPickTool,
  onToggleSnap
}: PlanningInspectorProps): ReactElement {
  return (
    <>
      {/* Element section (P4) — TOP, above Tools/Canvas: the current selection is the focus, so its
          controls lead. Absent (no placeholder) when nothing is selected — baseline P3 panel. */}
      {element && <ElementInspectorSection model={element} />}

      <InspectorSection label="Tools" persistKey="planning.tools">
        {/* The 8-tool palette as a 4×2 icon grid. Radiogroup semantics (one active tool); the
            bare-letter shortcut (from TOOL_META) sits in the corner + the tooltip, mirroring the
            deleted on-board cluster. Active tool is accent-washed via [data-on]. Arrow keys move
            + select with a roving tabindex (P5 a11y — the shared primitives' radio pattern). */}
        <div
          className="ca-inspector-toolgrid"
          role="radiogroup"
          aria-label="Whiteboard tool"
          onKeyDown={(e) => inspectorRadioGroupKeyDown(e, (i) => onPickTool(TOOLS[i].tool))}
        >
          {TOOLS.map(({ tool: t, icon }) => {
            const meta = TOOL_META[t]
            const on = tool === t
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={meta.label}
                tabIndex={on ? 0 : -1}
                data-on={on || undefined}
                data-test={`plan-tool-${t}`}
                className="ca-inspector-tool"
                title={`${meta.label} (${meta.key.toUpperCase()})`}
                onClick={() => onPickTool(t)}
              >
                <Icon name={icon} size={16} />
                <span className="ca-inspector-tool-k" aria-hidden>
                  {meta.key.toUpperCase()}
                </span>
              </button>
            )
          })}
        </div>
      </InspectorSection>

      <InspectorSection label="Canvas" persistKey="planning.canvas">
        <InspectorRow label="Snap to grid">
          <InspectorToggle
            checked={snapEnabled}
            onChange={() => onToggleSnap()}
            ariaLabel="Snap to grid"
          />
        </InspectorRow>
        {/* Export → the shipped PNG/SVG popover, re-homed as a labelled inspector action. */}
        <ExportPopover board={board} variant="inspector" />
      </InspectorSection>
    </>
  )
}

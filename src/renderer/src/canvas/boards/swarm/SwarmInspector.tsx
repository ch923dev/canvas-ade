/**
 * SwarmInspector — the Swarm board's per-type content for the Board Inspector flyout (the
 * reveal-on-select popover; user feedback 2026-08-01: THIS is where dock-terminal config lives,
 * not the ⋯ menu and not pane-header chrome). Presentation-only, TerminalInspector's discipline:
 * SwarmBoard owns the state/handlers and portals this into the shell's slot, so the font
 * controls reuse the exact same persist path (updateBoard fontSize pin + sticky default) the
 * docked pane's Ctrl+±/wheel shortcuts use.
 *
 * The font controls act on the ACTIVE docked worker (the dock's selected tab); the meta row
 * names it so a multi-worker dock is unambiguous. No docked workers → a quiet meta line says
 * so instead of an empty section (the "flyout shows nothing" confusion this lands to fix).
 */
import type { ReactElement } from 'react'
import {
  InspectorAction,
  InspectorMeta,
  InspectorRow,
  InspectorSection,
  InspectorStepper
} from '../../inspector/primitives'

export interface SwarmInspectorProps {
  /** Active docked worker's title, or null when nothing is docked (renders the empty hint). */
  workerTitle: string | null
  /** Effective render font (pt) of the active docked worker. */
  font: number
  defaultFont: number
  onDecFont: () => void
  onIncFont: () => void
  decFontDisabled: boolean
  incFontDisabled: boolean
  onResetFont: () => void
  resetFontDisabled: boolean
}

export function SwarmInspector({
  workerTitle,
  font,
  defaultFont,
  onDecFont,
  onIncFont,
  decFontDisabled,
  incFontDisabled,
  onResetFont,
  resetFontDisabled
}: SwarmInspectorProps): ReactElement {
  return (
    <InspectorSection label="Dock terminal" persistKey="swarm.dockTerminal">
      {workerTitle === null ? (
        <InspectorMeta label="Worker" value="none docked" />
      ) : (
        <>
          <InspectorMeta label="Worker" value={workerTitle} />
          <InspectorRow label="Font size">
            <InspectorStepper
              value={font}
              onDec={onDecFont}
              onInc={onIncFont}
              decDisabled={decFontDisabled}
              incDisabled={incFontDisabled}
              decLabel="Smaller font (Ctrl -)"
              incLabel="Bigger font (Ctrl +)"
            />
          </InspectorRow>
          <InspectorAction
            onClick={onResetFont}
            disabled={resetFontDisabled}
            dataTest="swarm-inspector-font-reset"
          >{`Reset to default (${defaultFont})`}</InspectorAction>
        </>
      )}
    </InspectorSection>
  )
}

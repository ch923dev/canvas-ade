/**
 * TerminalInspector — the Terminal board's per-type content for the Board Inspector (P0.5, the first
 * concrete consumer of the inspector primitives toolkit). Presentation-only: TerminalBoard owns all
 * state/handlers and portals this into the shell's slot, so every control here reuses the EXACT same
 * handler the title-bar action uses (no duplication, no lifted state).
 *
 * Additive: the title-bar actions stay as-is in this slice; this surfaces the same controls as labeled
 * rows (plus the keyboard-only Find and the otherwise-opaque shell/command/cwd config) — the
 * visibility win. Sections mirror docs/research/mocks/board-inspector-mock.
 */
import type { ReactElement } from 'react'
import { Icon } from '../../Icon'
import {
  InspectorAction,
  InspectorMeta,
  InspectorRow,
  InspectorSection,
  InspectorStepper
} from '../../inspector/primitives'

export interface TerminalInspectorProps {
  running: boolean
  interruptSent: boolean
  onInterrupt: () => void
  /** Effective render font (pt) shown between the steppers. */
  font: number
  defaultFont: number
  onDecFont: () => void
  onIncFont: () => void
  decFontDisabled: boolean
  incFontDisabled: boolean
  onResetFont: () => void
  /** A resumable agent session exists → offer Resume / New instead of a bare Restart. */
  canResume: boolean
  onRestart: () => void
  onResume: () => void
  onNew: () => void
  recapShown: boolean
  onToggleRecap: () => void
  onFind: () => void
  shell?: string
  command?: string
  cwd?: string
  onConfigure: () => void
  onPushPreview: () => void
  onChooseTarget: () => void
}

export function TerminalInspector({
  running,
  interruptSent,
  onInterrupt,
  font,
  defaultFont,
  onDecFont,
  onIncFont,
  decFontDisabled,
  incFontDisabled,
  onResetFont,
  canResume,
  onRestart,
  onResume,
  onNew,
  recapShown,
  onToggleRecap,
  onFind,
  shell,
  command,
  cwd,
  onConfigure,
  onPushPreview,
  onChooseTarget
}: TerminalInspectorProps): ReactElement {
  return (
    <>
      <InspectorSection label="Appearance">
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
        >{`Reset to default (${defaultFont})`}</InspectorAction>
      </InspectorSection>

      <InspectorSection label="Session">
        {running && (
          <InspectorAction
            icon={<Icon name="stop" size={14} />}
            active={interruptSent}
            kbd="^C"
            onClick={onInterrupt}
            title="Interrupt (Ctrl-C)"
            dataTest="inspector-interrupt"
          >
            {interruptSent ? 'Interrupt — sent' : 'Interrupt'}
          </InspectorAction>
        )}
        {canResume ? (
          <>
            <InspectorAction icon={<Icon name="play" size={14} />} onClick={onResume}>
              Resume session
            </InspectorAction>
            <InspectorAction icon={<Icon name="plus" size={14} />} onClick={onNew}>
              New session
            </InspectorAction>
          </>
        ) : (
          <InspectorAction
            icon={<Icon name="restart" size={14} />}
            onClick={onRestart}
            dataTest="inspector-restart"
          >
            Restart
          </InspectorAction>
        )}
        <InspectorAction
          icon={<Icon name="back" size={14} />}
          active={recapShown}
          onClick={onToggleRecap}
        >
          {recapShown ? 'Show terminal' : 'View recap'}
        </InspectorAction>
        <InspectorAction
          icon={<Icon name="search" size={14} />}
          kbd="^F"
          onClick={onFind}
          dataTest="inspector-find"
        >
          Find in terminal
        </InspectorAction>
      </InspectorSection>

      <InspectorSection label="Configuration">
        {shell && <InspectorMeta label="Shell" value={shell} />}
        {command && <InspectorMeta label="Command" value={command} />}
        {cwd && <InspectorMeta label="cwd" value={cwd} />}
        <InspectorAction
          icon={<Icon name="settings" size={14} />}
          onClick={onConfigure}
          dataTest="inspector-configure"
        >
          Edit…
        </InspectorAction>
      </InspectorSection>

      <InspectorSection label="Linking">
        <InspectorAction icon={<Icon name="globe" size={14} />} primary onClick={onPushPreview}>
          Push to preview
        </InspectorAction>
        <InspectorAction icon={<Icon name="connector" size={14} />} onClick={onChooseTarget}>
          Choose target…
        </InspectorAction>
      </InspectorSection>
    </>
  )
}

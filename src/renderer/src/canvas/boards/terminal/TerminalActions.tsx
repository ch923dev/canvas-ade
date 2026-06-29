/**
 * The Terminal board's title-bar action cluster (BoardFrame action slot): the transient interrupt
 * chip, font ± (hover/selected only), Stop (running only), preview Globe, Configure, Restart, and
 * the recap Flip. A presentation-only move out of `TerminalBoard.tsx` (max-lines ratchet — same
 * discipline as PlanningToolbar): the board owns all state/handlers and threads them in here.
 *
 * `restartBtnRef` is created by the board (it anchors the resume/new menu rendered there) and just
 * attached to the Restart span here; the `config-`/`flip-`/`interrupt-sent` data-test handles are
 * preserved verbatim for the e2e suite.
 */
import type { ReactElement, RefObject } from 'react'
import { IconBtn } from '../../BoardFrame'
import { MIN_TERMINAL_FONT, MAX_TERMINAL_FONT } from './terminalFont'
import { interruptChip } from './terminalBoardStyles'
import type { Gesture } from '../terminalPreview'

export interface TerminalActionsProps {
  boardId: string
  selected: boolean
  hovered: boolean
  running: boolean
  interruptSent: boolean
  onInterrupt: () => void
  effectiveFont: number
  onNudgeFont: (delta: number) => void
  onPreview: (gesture: Gesture) => void
  configOpen: boolean
  onConfigure: () => void
  restartBtnRef: RefObject<HTMLSpanElement | null>
  canResume: boolean
  restartMenuOpen: boolean
  onRestartClick: () => void
  flipped: boolean
  onToggleFlip: () => void
}

export function TerminalActions({
  boardId,
  selected,
  hovered,
  running,
  interruptSent,
  onInterrupt,
  effectiveFont,
  onNudgeFont,
  onPreview,
  configOpen,
  onConfigure,
  restartBtnRef,
  canResume,
  restartMenuOpen,
  onRestartClick,
  flipped,
  onToggleFlip
}: TerminalActionsProps): ReactElement {
  return (
    <>
      {/* TERM-06: transient "interrupt sent" chip (sits by the pill, before the buttons). */}
      {interruptSent && (
        <span className="nodrag" style={interruptChip} data-test="interrupt-sent">
          ⏹ interrupt sent
        </span>
      )}
      {(selected || hovered) && (
        <>
          <IconBtn
            name="minus"
            title="Smaller font (Ctrl -)"
            onClick={() => onNudgeFont(-1)}
            disabled={effectiveFont <= MIN_TERMINAL_FONT}
          />
          <IconBtn
            name="plus"
            title="Bigger font (Ctrl +)"
            onClick={() => onNudgeFont(1)}
            disabled={effectiveFont >= MAX_TERMINAL_FONT}
          />
        </>
      )}
      {running && (
        <IconBtn
          name="stop"
          title="Interrupt (Ctrl-C)"
          active={interruptSent}
          onClick={onInterrupt}
        />
      )}
      <IconBtn
        name="globe"
        title="Click: preview in linked browser · Hold / right-click: choose browser(s)"
        onClick={() => onPreview('tap')}
        onLongPress={() => onPreview('hold')}
        onContextMenu={() => onPreview('hold')}
      />
      {/* Configure opens the unified New Terminal dialog in edit mode (a modal). The data-test
          span gives the e2e a click handle (IconBtn forwards no ref/data-test). */}
      <span data-test={`config-${boardId}`} style={{ display: 'inline-flex' }}>
        <IconBtn
          name="settings"
          title="Configure terminal"
          active={configOpen}
          onClick={onConfigure}
        />
      </span>
      {/* The restart span anchors the resume/new menu (IconBtn forwards no ref): it's the
          menu's outside-close exclusion, so the trigger click toggles. */}
      <span ref={restartBtnRef} style={{ display: 'inline-flex' }}>
        <IconBtn
          name="restart"
          title={canResume ? 'Restart (resume or new session)' : 'Restart'}
          active={restartMenuOpen}
          onClick={onRestartClick}
        />
      </span>
      {/* T15: flip to the recap back-face. IconBtn has no data-test prop, so the e2e/test
          hook (`flip-<id>`) rides a wrapping span. */}
      <span data-test={`flip-${boardId}`} style={{ display: 'inline-flex' }}>
        <IconBtn
          name="back"
          title={flipped ? 'Show terminal' : 'Show recap'}
          active={flipped}
          onClick={onToggleFlip}
        />
      </span>
    </>
  )
}

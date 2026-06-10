/**
 * Restart popover for a terminal with a resumable agent session (T-resume), on the
 * shared Menu shell (D1-C → D2-B migration): body portal + viewport clamp, Escape /
 * outside-pointerdown / resize auto-close, `menuitem` roving tabindex + arrow keys,
 * focus restore, and the ADR 0002 detach-live-previews-while-open signal. The old
 * hand-rolled `.ca-port-picker` version had none of the dismissal paths (the audit's
 * "no auto-close"). Portaling also keeps it reachable from the recap back-face —
 * you often resume FROM the recap. The anchor is the title-bar Restart button's
 * wrapper span (excluded from outside-close so its own click can toggle).
 */
import type { ReactElement, RefObject } from 'react'
import { Menu } from '../../Menu'

export function TerminalRestartMenu({
  anchor,
  onResume,
  onNew,
  onClose
}: {
  anchor: RefObject<HTMLElement | null>
  /** Respawn with `claude --resume <sessionId>` (sanitised upstream — resumeCommand). */
  onResume: () => void
  /** Respawn with the board's own launch command (fresh session). */
  onNew: () => void
  onClose: () => void
}): ReactElement {
  const pick = (fn: () => void) => (): void => {
    onClose()
    fn()
  }
  return (
    <Menu
      anchor={anchor}
      align="right"
      label="Restart terminal"
      className="board-menu"
      onClose={onClose}
    >
      <button
        className="board-menu-item"
        role="menuitem"
        data-test="restart-resume"
        onClick={pick(onResume)}
      >
        Resume session
      </button>
      <button
        className="board-menu-item"
        role="menuitem"
        data-test="restart-new"
        onClick={pick(onNew)}
      >
        New session
      </button>
    </Menu>
  )
}

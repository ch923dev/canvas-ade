/**
 * Phase 5 · S3 — the idle-terminal affordance. A terminal that mounts idle (disk-restored /
 * duplicated) must never silently auto-spawn (M-1), so it shows an explicit Start. Two presentations:
 *  - fresh idle (no restored snapshot) → the opaque centered overlay over the empty `--inset` well.
 *  - restored idle (S3 wrote the prior scrollback back into the frozen term) → a bottom bar
 *    (TerminalRestoredBar) so the restored (read-only) output stays VISIBLE above it — the opaque
 *    overlay would hide the very output S3 exists to show.
 * Extracted from TerminalBoard so the host renders one element (and stays under the file-size ratchet).
 */
import type { ReactElement } from 'react'
import type { TerminalState } from '../terminalState'
import { idleOverlay, startBtn } from './terminalBoardStyles'
import { TerminalRestoredBar } from './TerminalRestoredBar'

export interface TerminalIdleAffordanceProps {
  state: TerminalState
  /** True when this idle mount restored a persisted snapshot (show the bar, not the opaque overlay). */
  restored: boolean
  /** Bg sessions Phase 5: the session exited while its project was backgrounded — the bar
   *  reports "exited in background (code N)" instead of the plain restored label. */
  restoredExitCode?: number | null
  /** Agent/shell identity for the Start label (e.g. "claude"). */
  identity: string
  onStart: () => void
  /** #270: the board's theme background, so the fresh-idle overlay matches a themed terminal instead
   *  of flashing the default --inset. Falls back to idleOverlay's own bg when absent. */
  background?: string
  /** The board has a resumable agent session → the restored bar also offers Resume (reattach the
   *  agent conversation via its transcript), beside Start. Ignored by the fresh-idle overlay. */
  canResume?: boolean
  onResume?: () => void
}

export function TerminalIdleAffordance({
  state,
  restored,
  restoredExitCode,
  identity,
  background,
  onStart,
  canResume,
  onResume
}: TerminalIdleAffordanceProps): ReactElement | null {
  if (state !== 'idle') return null
  if (restored)
    return (
      <TerminalRestoredBar
        identity={identity}
        exitCode={restoredExitCode ?? undefined}
        onStart={onStart}
        canResume={canResume}
        onResume={onResume}
      />
    )
  return (
    <div
      className="nodrag"
      style={background ? { ...idleOverlay, background } : idleOverlay}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button style={startBtn} onClick={onStart}>
        Start {identity}
      </button>
    </div>
  )
}

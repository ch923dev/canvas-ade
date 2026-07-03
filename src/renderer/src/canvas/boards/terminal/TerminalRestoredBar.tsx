/**
 * Phase 5 · S3 — a bottom bar for an idle terminal that RESTORED its last session's scrollback from
 * the `.canvas/terminal/<id>.snapshot` sidecar. The restored output stays visible (read-only) in the
 * well; this compact bar — same pattern as TerminalEndCTA (pinned bottom, never covers the
 * scrollback) — carries the explicit Start that spawns a fresh PTY. This upholds the M-1 "restored
 * terminals are idle, no silent auto-spawn" rule while keeping the prior output legible (the reason
 * S3 exists), which the opaque centered idle overlay could not. `nodrag` + swallowed pointer/mouse
 * down keep React Flow from treating a press as a node-drag and the well from focus-stealing.
 */
import type { CSSProperties, ReactElement } from 'react'

export interface TerminalRestoredBarProps {
  /** Agent/shell identity for the Start label (e.g. "claude"). */
  identity: string
  /** Bg sessions Phase 5 (R6 residue): the session EXITED while its project was backgrounded —
   *  say so (with the code) instead of the plain "Session restored" label; the residue tail is
   *  already spliced into the read-only buffer above. Undefined = plain snapshot restore. */
  exitCode?: number
  onStart: () => void
  /** The board carries an `agentSessionId` → offer Resume (reattach the agent conversation) beside
   *  Start. The snapshot restores the SCREEN; Resume (`claude --resume <id>`) reloads the agent's
   *  own transcript into a fresh process. Absent for a plain shell / an agent with no transcript. */
  canResume?: boolean
  onResume?: () => void
}

export function TerminalRestoredBar({
  identity,
  exitCode,
  onStart,
  canResume,
  onResume
}: TerminalRestoredBarProps): ReactElement {
  const stop = (e: React.PointerEvent | React.MouseEvent): void => e.stopPropagation()
  const exited = exitCode !== undefined
  return (
    <div
      className="nodrag"
      data-test="terminal-restored-bar"
      data-exit-code={exited ? exitCode : undefined}
      style={bar}
      onPointerDown={stop}
      onMouseDown={stop}
    >
      <span style={label}>
        <span style={exited && exitCode !== 0 ? errDot : dot} />
        <span style={labelText}>
          {exited
            ? `Exited in background (code ${exitCode}) — read-only`
            : 'Session restored — read-only'}
        </span>
      </span>
      {canResume && onResume && (
        <button type="button" style={ghostBtn} onClick={onResume} data-test="restored-resume">
          Resume
        </button>
      )}
      <button type="button" style={primaryBtn} onClick={onStart} data-test="restored-start">
        Start {identity}
      </button>
    </div>
  )
}

const bar: CSSProperties = {
  position: 'absolute',
  left: 10,
  right: 10,
  bottom: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-ctl)',
  padding: '6px 8px 6px 10px',
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
  // Above xterm's stacked layers (.xterm-link-layer is z-index 2) so its buttons stay clickable —
  // the exact reason TerminalEndCTA sits at 3 (a lower z-index paints but the transparent link
  // canvas swallows the click). Still under the config pop (5).
  zIndex: 3
}

const label: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--text-2)'
}

const labelText: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  flex: 'none',
  background: 'var(--text-3)'
}

/** Non-zero background exit: the dot goes --err so the death is visible at a glance. */
const errDot: CSSProperties = {
  ...dot,
  background: 'var(--err)'
}

const btnBase: CSSProperties = {
  font: 'inherit',
  fontFamily: 'var(--sans)',
  fontSize: 11,
  padding: '4px 11px',
  borderRadius: 'var(--r-ctl)',
  cursor: 'pointer',
  flex: 'none'
}

const primaryBtn: CSSProperties = {
  ...btnBase,
  border: '1px solid rgba(79, 140, 255, 0.5)',
  background: 'rgba(79, 140, 255, 0.14)',
  color: '#cfe0ff'
}

const ghostBtn: CSSProperties = {
  ...btnBase,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-3)'
}

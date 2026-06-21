/**
 * TERM-04: an in-well re-run CTA for a terminal that has exited or failed to spawn.
 * Before this, an exited/spawn-failed terminal whose launchCommand was set offered no
 * affordance in the well itself — you had to find the title-bar Restart. This is a
 * compact bar pinned to the BOTTOM of the well, so it never covers the scrollback (the
 * final output stays readable for a post-mortem):
 *   - exited:       ● {identity} exited        [Resume?]  [Restart]
 *   - spawn-failed: ▲ Couldn't start {identity} [Configure] [Retry]
 * Reduced-noise: one bar, no toast. Styling matches the file's other inline well chrome
 * (idleOverlay/startBtn) — var() tokens, no raw hex — so it stays in the terminal zone
 * (no shared index.css edit). `nodrag` + a swallowed pointerdown/mousedown keep React
 * Flow from treating a press as a node-drag and the well from focus-stealing into xterm.
 */
import type { CSSProperties, ReactElement } from 'react'

export interface TerminalEndCTAProps {
  /** True for spawn-failed (else exited). */
  failed: boolean
  /** Agent/shell identity for the label (e.g. "claude"). */
  identity: string
  /** A prior session id exists → offer Resume on the exited variant. */
  canResume: boolean
  onRestart: () => void
  onResume: () => void
  onConfigure: () => void
}

export function TerminalEndCTA({
  failed,
  identity,
  canResume,
  onRestart,
  onResume,
  onConfigure
}: TerminalEndCTAProps): ReactElement {
  const stop = (e: React.PointerEvent | React.MouseEvent): void => e.stopPropagation()
  return (
    <div
      className="nodrag"
      data-test="terminal-end-cta"
      style={bar}
      onPointerDown={stop}
      onMouseDown={stop}
    >
      <span style={label}>
        <span style={{ ...dot, background: failed ? 'var(--err)' : 'var(--text-3)' }} />
        <span style={labelText}>
          {failed ? `Couldn't start ${identity}` : `${identity} exited`}
        </span>
      </span>
      {failed ? (
        <button type="button" style={ghostBtn} onClick={onConfigure}>
          Configure
        </button>
      ) : (
        canResume && (
          <button type="button" style={ghostBtn} onClick={onResume} data-test="end-cta-resume">
            Resume
          </button>
        )
      )}
      <button type="button" style={primaryBtn} onClick={onRestart} data-test="end-cta-restart">
        {failed ? 'Retry' : 'Restart'}
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
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)'
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

const dot: CSSProperties = { width: 7, height: 7, borderRadius: '50%', flex: 'none' }

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

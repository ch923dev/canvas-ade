/**
 * WS-3 — the terminal dialog's read-only Workspace line (+ the missing-folder warning), placed
 * directly above Working dir. The data comes from `useBoardWorkspace` (membership is never picked
 * here — see that module's header).
 */
import type { CSSProperties, ReactElement } from 'react'
import { fieldLabel, fieldWrap } from './newTerminalStyles'
import type { BoardWorkspaceView } from './useBoardWorkspace'

export function WorkspaceScopeRow({ view }: { view: BoardWorkspaceView }): ReactElement {
  // Hue NAME → CSS is WS-5's palette (`--ws-<hue>`); until it lands the dot is neutral.
  const tint = view.color ? `var(--ws-${view.color}, var(--text-3))` : 'var(--text-3)'
  return (
    <div style={fieldWrap} data-test="new-terminal-workspace">
      <span style={fieldLabel}>Workspace</span>
      <span style={line}>
        <span style={{ ...dot, background: tint }} aria-hidden />
        <span>{view.name}</span>
        {view.shown && <span style={path}>· {view.shown}</span>}
      </span>
      {view.problem && (
        <span role="alert" style={warn} data-test="new-terminal-workspace-problem">
          ⚠ {view.problem}
        </span>
      )}
    </div>
  )
}

const line: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 22,
  fontSize: 12.5,
  color: 'var(--text)'
}
const dot: CSSProperties = { width: 8, height: 8, borderRadius: 'var(--r-pill)', flex: 'none' }
const path: CSSProperties = { fontFamily: 'var(--mono)', color: 'var(--text-3)' }
const warn: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--warn)' }

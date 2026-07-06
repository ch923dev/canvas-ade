/**
 * Shared "no project open" empty state for the project-scoped panes (Sessions · Agents). Every
 * control under the Project tab is keyed to the ACTIVE project; with none open there is nothing to
 * configure, so the pane shows this quiet prompt instead — the full-pane analogue of
 * OrchestrationPane's inline "— open a project" disabling. (Appearance is intentionally NOT gated:
 * the backdrop picker stands alone.)
 */
import { type ReactElement } from 'react'

export function NoProjectEmpty(): ReactElement {
  return (
    <div
      data-test="settings-no-project"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 6,
        padding: '28px 16px',
        color: 'var(--text-3)'
      }}
    >
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', fontWeight: 500 }}>No project open</div>
      <div style={{ fontSize: 11.5, lineHeight: '16px', maxWidth: '34ch' }}>
        Open or create a project to manage its background, appearance, and agent settings.
      </div>
    </div>
  )
}

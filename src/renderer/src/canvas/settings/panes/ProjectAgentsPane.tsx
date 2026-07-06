/**
 * Project · Agents detail pane — the per-project agent-orchestration consent toggle, surfaced under
 * the Project tab so every project-scoped control has one home. This is the SAME per-project consent
 * as Agents & AI › Orchestration (both read/write the shared `useOrchestrationStore`, so they never
 * drift); only the app-wide worker spawn-cap stays over there — it is a process singleton, NOT
 * project-scoped, so it has no place under a per-project tab.
 *
 * Turning ON routes through the informed Enable modal (consent + the security callout live there),
 * which CLOSES Settings first (`onClose`) — two shared Modals must not stack. Turning OFF is a direct
 * revoke, guarded busy so a double-click can't fire two interleaved `setConsent('declined')` calls.
 */
import { useState, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'
import { pane } from '../paneStyles'
import { NoProjectEmpty } from './NoProjectEmpty'

export function ProjectAgentsPane({ onClose }: { onClose: () => void }): ReactElement {
  const projectDir = useCanvasStore((s) => s.project.dir)
  const enabled = useOrchestrationStore((s) => s.enabled)
  const setModal = useOrchestrationStore((s) => s.setModal)
  const setCache = useOrchestrationStore((s) => s.setEnabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (projectDir === null) return <NoProjectEmpty />

  const onToggle = async (): Promise<void> => {
    // Turning ON opens the informed Enable modal (closes Settings first — see header).
    if (!enabled) {
      onClose()
      setModal('enable')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.orchestration.setConsent('declined')
      if (!r.ok) {
        setError('Could not update agent orchestration — please try again.')
        setBusy(false)
        return
      }
      setCache(false)
    } catch {
      setError('Could not update agent orchestration — please try again.')
    }
    setBusy(false)
  }

  return (
    <div style={pane.section}>
      <div style={pane.setrow} data-test="settings-project-orchestration-row">
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>Agent orchestration</div>
          <div style={pane.rowSub}>
            Let terminal agents drive this canvas along your cables. Off by default; enabling opens
            the consent step.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Agent orchestration (this project)"
          disabled={busy}
          onClick={() => void onToggle()}
          data-test="settings-project-orchestration-toggle"
          style={{
            ...pane.toggle,
            background: enabled ? 'var(--accent)' : 'var(--border-strong)',
            cursor: busy ? 'default' : 'pointer'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: enabled ? 17 : 2 }} />
        </button>
      </div>

      {error && (
        <div role="alert" data-test="settings-project-orchestration-error" style={pane.error}>
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Orchestration detail pane — the `orchestration` tile. The project consent toggle + Sync button
 * (both re-open the informed onboarding modals hosted in AppChrome's <OrchestrationModals/>) plus
 * the app-wide worker spawn-cap (the runaway-swarm guard, persisted to userData). Ported from
 * `SettingsModal`'s orchestration block.
 *
 * Opening either onboarding modal CLOSES Settings first (`onClose`): those modals ride the same
 * shared Modal, and stacking them over this panel would duel the focus trap + Esc. The spawn-cap is
 * committed on blur (immediate-apply, matching the toggle) — no Save button in this pane; the store
 * clamps to [MIN,MAX] before the IPC re-validates.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'
import { useOrchestrationConfigStore } from '../../../store/orchestrationConfigStore'
import {
  WORKER_SPAWN_CAP,
  WORKER_SPAWN_CAP_MIN,
  WORKER_SPAWN_CAP_MAX
} from '../../../store/workerPool'
import { pane } from '../paneStyles'

export function OrchestrationPane({ onClose }: { onClose: () => void }): ReactElement {
  const projectDir = useCanvasStore((s) => s.project.dir)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // String-backed so the field can be cleared; hydrated from the config store, committed on blur.
  const [maxWorkers, setMaxWorkers] = useState('')

  const orchestrationEnabled = useOrchestrationStore((s) => s.enabled)
  const setOrchestrationModal = useOrchestrationStore((s) => s.setModal)
  const setOrchestrationCache = useOrchestrationStore((s) => s.setEnabled)

  useEffect(() => {
    let cancelled = false
    void useOrchestrationConfigStore
      .getState()
      .load()
      .then(() => {
        if (!cancelled) setMaxWorkers(String(useOrchestrationConfigStore.getState().spawnCap))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Turning ON routes through the informed Enable modal (consent + the security callout live
  // there); turning OFF is a direct revoke. Opening a modal closes Settings first (see header).
  const openModal = (view: 'enable' | 'sync'): void => {
    onClose()
    setOrchestrationModal(view)
  }
  const onToggle = async (): Promise<void> => {
    if (!orchestrationEnabled) {
      openModal('enable')
      return
    }
    // Guard the async revoke (busy-disabled) so a rapid double-click can't fire two concurrent
    // setConsent('declined') calls whose side-effects interleave.
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.orchestration.setConsent('declined')
      if (!r.ok) {
        setError('Could not update agent orchestration — please try again.')
        setBusy(false)
        return
      }
      setOrchestrationCache(false)
    } catch {
      setError('Could not update agent orchestration — please try again.')
    }
    setBusy(false)
  }

  // Commit the cap on blur: a valid int → persist (store clamps); blank/invalid → snap back to the
  // stored value so the field never shows an un-persisted number.
  const commitCap = async (): Promise<void> => {
    const parsed = parseInt(maxWorkers, 10)
    if (!Number.isInteger(parsed)) {
      setMaxWorkers(String(useOrchestrationConfigStore.getState().spawnCap))
      return
    }
    setError(null)
    try {
      const r = await useOrchestrationConfigStore.getState().save(parsed)
      if (!r.ok) {
        setError('Could not save the worker cap — please try again.')
        setMaxWorkers(String(useOrchestrationConfigStore.getState().spawnCap))
        return
      }
      // Reflect the store's clamped value back into the field.
      setMaxWorkers(String(useOrchestrationConfigStore.getState().spawnCap))
    } catch {
      setError('Could not save the worker cap — please try again.')
      setMaxWorkers(String(useOrchestrationConfigStore.getState().spawnCap))
    }
  }

  return (
    <div style={pane.section}>
      <div style={pane.setrow} data-test="settings-orchestration-row">
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>
            Agent orchestration
            {projectDir === null && (
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> — open a project</span>
            )}
          </div>
          <div style={pane.rowSub}>Drive this canvas from terminal agents, along your cables.</div>
        </div>
        <button
          type="button"
          style={{ ...pane.syncBtn, ...(projectDir === null ? pane.ctlDisabled : null) }}
          disabled={projectDir === null}
          onClick={() => openModal('sync')}
          data-test="settings-orchestration-sync"
        >
          <Icon name="refresh" size={12} />
          Sync
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={orchestrationEnabled}
          aria-label="Agent orchestration (this project)"
          disabled={busy || projectDir === null}
          onClick={() => void onToggle()}
          data-test="settings-orchestration-toggle"
          style={{
            ...pane.toggle,
            background: orchestrationEnabled ? 'var(--accent)' : 'var(--border-strong)',
            cursor: projectDir === null ? 'not-allowed' : 'pointer',
            opacity: projectDir === null ? 0.5 : 1
          }}
        >
          <span style={{ ...pane.toggleKnob, left: orchestrationEnabled ? 17 : 2 }} />
        </button>
      </div>

      {/* App-wide MCP spawn cap. NOT project-gated — the orchestrator is a process singleton, so this
          applies across every project. Persisted into orchestration-config.json (userData). */}
      <label style={pane.field}>
        <span style={pane.label}>Max concurrent workers</span>
        <input
          aria-label="Max concurrent workers"
          type="number"
          min={WORKER_SPAWN_CAP_MIN}
          max={WORKER_SPAWN_CAP_MAX}
          step={1}
          inputMode="numeric"
          value={maxWorkers}
          placeholder={String(WORKER_SPAWN_CAP)}
          onChange={(e) => setMaxWorkers(e.target.value)}
          onBlur={() => void commitCap()}
          style={pane.input}
          data-test="settings-spawn-cap"
        />
        <span style={pane.hint}>
          Hard cap on agent boards the orchestrator spawns at once (runaway-swarm guard).{' '}
          {WORKER_SPAWN_CAP_MIN}–{WORKER_SPAWN_CAP_MAX} · default {WORKER_SPAWN_CAP}.
        </span>
      </label>

      {error && (
        <div role="alert" data-test="settings-orchestration-error" style={pane.error}>
          {error}
        </div>
      )}
    </div>
  )
}

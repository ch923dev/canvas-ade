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
  // Lead terminal (orchestration Phase 1): the designated lead board id (null = none), the
  // dropdown selection, and the two-step grant confirm (first click arms, second confirms —
  // the explicit human act the consent-gated mint path requires, without stacking a modal).
  const [leadBoardId, setLeadBoardId] = useState<string | null>(null)
  const [leadPick, setLeadPick] = useState('')
  const [leadArmed, setLeadArmed] = useState(false)
  const [leadBusy, setLeadBusy] = useState(false)
  const [leadNote, setLeadNote] = useState<string | null>(null)
  // Primitive-join selector (id/title rows, NUL-separated) — no fresh-array churn per store tick.
  const terminalRows = useCanvasStore((s) =>
    s.boards
      .filter((b) => b.type === 'terminal')
      .map((b) => `${b.id}\u0000${b.title}`)
      .join('\n')
  )
  const terminals = terminalRows
    ? terminalRows.split('\n').map((row) => {
        const [id, title] = row.split('\u0000')
        return { id, title }
      })
    : []
  const leadTitle = terminals.find((t) => t.id === leadBoardId)?.title

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
    // Lead status is MAIN-held runtime state (no store) — hydrate on open.
    void window.api.orchestration
      .getLeadStatus()
      .then((r) => {
        if (!cancelled) setLeadBoardId(r.boardId)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Two-step grant: first click ARMS (button relabels to the explicit confirm), second click
  // performs the consent-gated grant. Any selection change disarms.
  const onGrantLead = async (): Promise<void> => {
    if (!leadArmed) {
      setLeadArmed(true)
      return
    }
    setLeadArmed(false)
    setLeadBusy(true)
    setLeadNote(null)
    try {
      const r = await window.api.orchestration.grantLead(leadPick)
      if (r.ok) {
        setLeadBoardId(leadPick)
        setLeadNote(
          'Lead granted. Restart the agent in that terminal (or respawn the board) so it picks up the lead token.'
        )
      } else if (r.reason === 'already-active') {
        setLeadNote('Another terminal already holds the lead role — revoke it first.')
      } else if (r.reason === 'consent') {
        setLeadNote('Enable agent orchestration for this project first.')
      } else if (r.reason === 'no-server') {
        setLeadNote('Orchestration server is not running — open a terminal first, then try again.')
      } else {
        setLeadNote('Could not grant the lead role — the board must be a live terminal.')
      }
    } catch {
      setLeadNote('Could not grant the lead role — please try again.')
    }
    setLeadBusy(false)
  }

  const onRevokeLead = async (): Promise<void> => {
    setLeadBusy(true)
    setLeadNote(null)
    try {
      await window.api.orchestration.revokeLead()
      setLeadBoardId(null)
      setLeadNote('Lead role revoked — its token is dead immediately.')
    } catch {
      setLeadNote('Could not revoke the lead role — please try again.')
    }
    setLeadBusy(false)
  }

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

      {/* Lead terminal (orchestration Phase 1, precondition X): the consent-gated grant of the
          wire-facing orchestrator role to ONE terminal board. Single-active-lead; granting only
          DESIGNATES — the lead token is minted at the next agent (re)start of that terminal. */}
      <div style={pane.divider} />
      <div style={pane.field} data-test="settings-lead-section">
        <span style={pane.label}>Lead terminal</span>
        {leadBoardId !== null ? (
          <div style={pane.setrow} data-test="settings-lead-current">
            <div style={{ flex: 1 }}>
              <div style={pane.rowTitle}>{leadTitle ?? leadBoardId}</div>
              <div style={pane.rowSub}>
                Holds the lead role: it can spawn worker terminals and dispatch along its own
                cables. Every dispatch still asks you first.
              </div>
            </div>
            <button
              type="button"
              style={{ ...pane.syncBtn, ...(leadBusy ? pane.ctlDisabled : null) }}
              disabled={leadBusy}
              onClick={() => void onRevokeLead()}
              data-test="settings-lead-revoke"
            >
              Revoke
            </button>
          </div>
        ) : (
          <div style={pane.row}>
            <select
              aria-label="Lead terminal board"
              value={leadPick}
              onChange={(e) => {
                setLeadPick(e.target.value)
                setLeadArmed(false)
              }}
              disabled={leadBusy || !orchestrationEnabled || projectDir === null}
              style={{ ...pane.input, flex: 1 }}
              data-test="settings-lead-pick"
            >
              <option value="">Choose a terminal…</option>
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              style={{
                ...pane.syncBtn,
                ...(leadBusy || leadPick === '' || !orchestrationEnabled || projectDir === null
                  ? pane.ctlDisabled
                  : null),
                ...(leadArmed ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : null)
              }}
              disabled={leadBusy || leadPick === '' || !orchestrationEnabled || projectDir === null}
              onClick={() => void onGrantLead()}
              data-test="settings-lead-grant"
            >
              {leadArmed ? 'Confirm grant' : 'Grant lead'}
            </button>
          </div>
        )}
        <span style={pane.hint}>
          {orchestrationEnabled
            ? 'Grants ONE terminal the orchestrator role over the wire: spawn workers, dispatch along its own cables, join results. Explicit grant only; revoke any time. Applies when that terminal’s agent next starts.'
            : 'Enable agent orchestration first — the lead role rides the same consent.'}
        </span>
        {leadNote && (
          <span role="status" data-test="settings-lead-note" style={pane.hint}>
            {leadNote}
          </span>
        )}
      </div>

      {error && (
        <div role="alert" data-test="settings-orchestration-error" style={pane.error}>
          {error}
        </div>
      )}
    </div>
  )
}

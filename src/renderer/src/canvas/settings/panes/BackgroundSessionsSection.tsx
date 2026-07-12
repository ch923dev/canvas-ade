/**
 * Settings › Terminal › "Background sessions" (PR-2, mock 4 of the user-approved design):
 * the close-with-running-sessions policy select (the close modal's "Always do this" writes
 * the same store), the background-exit notification toggle, and the surviveRestart master
 * toggle PR-1 deferred here. Own file (max-lines doctrine); rendered by TerminalPane.
 *
 * Immediate-apply with the optimistic-then-revert guard (the recap-consent BUG-065
 * precedent): a rejected/`{ok:false}` write never leaves a control showing a state that
 * did not persist. Renders null without `window.api.closeGuard` (the SettingsVoiceSection
 * discipline — unit mocks of the settings modal stay green without the preload).
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { PtyHostConfigView } from '../../../../../preload/closeGuardApi'
import { pane } from '../paneStyles'

const WRITE_ERROR = 'Could not update background-session settings — please try again.'

export function BackgroundSessionsSection(): ReactElement | null {
  const api = window.api?.closeGuard
  const [cfg, setCfg] = useState<PtyHostConfigView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    void api
      .getConfig()
      .then((c) => {
        if (!cancelled && c) setCfg(c)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  if (!api) return null

  const setField = (patch: Partial<PtyHostConfigView>): void => {
    if (!cfg) return
    const prev = cfg
    setCfg({ ...cfg, ...patch })
    setError(null)
    api
      .setConfig(patch)
      .then((r) => {
        if (!r.ok) {
          setCfg(prev)
          setError(WRITE_ERROR)
        }
      })
      .catch(() => {
        setCfg(prev)
        setError(WRITE_ERROR)
      })
  }

  const toggle = (
    field: 'notifyBackgroundExit' | 'surviveRestart',
    label: string
  ): ReactElement => {
    const on = cfg?.[field] ?? true
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={!cfg}
        data-test={`settings-bgsessions-${field}`}
        onClick={() => cfg && setField({ [field]: !on })}
        style={{
          ...pane.toggle,
          cursor: cfg ? 'pointer' : 'not-allowed',
          background: on ? 'var(--accent)' : 'var(--border-strong)'
        }}
      >
        <span style={{ ...pane.toggleKnob, left: on ? 17 : 2 }} />
      </button>
    )
  }

  return (
    <>
      <div style={pane.divider} />
      <div style={pane.head}>Background sessions</div>

      <div style={pane.setrow}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={pane.rowTitle}>When closing with running sessions</div>
          <div style={pane.rowSub}>
            “Keep in background” leaves agents running and puts Expanse in the system tray.
          </div>
        </div>
        <select
          aria-label="When closing with running sessions"
          data-test="settings-bgsessions-onclose"
          disabled={!cfg}
          value={cfg?.onCloseWithSessions ?? 'ask'}
          onChange={(e) =>
            setField({
              onCloseWithSessions: e.target.value as PtyHostConfigView['onCloseWithSessions']
            })
          }
          style={{ ...pane.input, flex: 'none' }}
        >
          <option value="ask">Ask every time</option>
          <option value="keep">Always keep in background</option>
          <option value="stop">Always stop everything</option>
        </select>
      </div>

      <div style={pane.setrow}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={pane.rowTitle}>Notify when a background agent finishes</div>
          <div style={pane.rowSub}>
            OS notification when a session exits while the window is closed.
          </div>
        </div>
        {toggle('notifyBackgroundExit', 'Notify when a background agent finishes')}
      </div>

      <div style={pane.setrow}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={pane.rowTitle}>Terminal sessions survive restarts</div>
          <div style={pane.rowSub}>
            Terminals run in a small background host so updates and crashes don’t kill them. Applies
            on the next app launch.
          </div>
        </div>
        {toggle('surviveRestart', 'Terminal sessions survive restarts')}
      </div>

      {error && (
        <div role="alert" data-test="settings-bgsessions-error" style={pane.error}>
          {error}
        </div>
      )}
    </>
  )
}

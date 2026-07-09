/**
 * Notifications detail pane — the `notifications` section. Controls the agent-lifecycle desktop
 * notifications: a master switch, three per-event toggles (Task done / Needs input / Errors &
 * focus), and "Only when window unfocused" (default off). Immediate-apply like ShortcutsPane: every
 * change writes through `notifications.set` (persisted to userData; the MAIN delivery gate reads the
 * same file fresh on each event). Per-board opt-out is the existing `monitorActivity` toggle on the
 * Terminal board — surfaced here as a hint, not a control.
 *
 * Non-electron test runtimes have no notifications bridge → render nothing (ShortcutsPane precedent).
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { NotificationsConfig } from '../../../../../preload'
import { pane } from '../paneStyles'

// Local default mirroring main `notificationsConfig.DEFAULT_NOTIFICATIONS` — pre-load UI state only
// (the persisted value replaces it on mount).
const DEFAULTS: NotificationsConfig = {
  enabled: true,
  onDone: true,
  onInput: true,
  onError: true,
  onlyWhenUnfocused: false
}

/** The three per-event toggles, in display order. */
const EVENTS: { key: 'onDone' | 'onInput' | 'onError'; title: string; sub: string }[] = [
  { key: 'onDone', title: 'Task done', sub: 'An agent finishes a task.' },
  { key: 'onInput', title: 'Needs input', sub: 'An agent is waiting on you (permission or idle).' },
  { key: 'onError', title: 'Errors & focus', sub: 'An agent errors or wants your attention.' }
]

export function NotificationsPane(): ReactElement | null {
  const [cfg, setCfg] = useState<NotificationsConfig>(DEFAULTS)
  const [error, setError] = useState<string | null>(null)

  const hasApi = typeof window !== 'undefined' && !!window.api?.notifications

  useEffect(() => {
    if (!hasApi) return
    let cancelled = false
    void window.api.notifications
      .get()
      .then((c) => {
        if (!cancelled && c) setCfg(c)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hasApi])

  const applyCfg = async (next: NotificationsConfig): Promise<void> => {
    const prev = cfg
    setCfg(next)
    setError(null)
    try {
      const r = await window.api.notifications.set(next)
      if (!r.ok) {
        setCfg(prev)
        setError('Could not save the setting — please try again.')
      }
    } catch {
      setCfg(prev)
      setError('Could not save the setting — please try again.')
    }
  }

  if (!hasApi) return null

  const toggleRow = (
    checked: boolean,
    onToggle: () => void,
    label: string,
    sub: string,
    opts?: { disabled?: boolean; test?: string }
  ): ReactElement => {
    const disabled = opts?.disabled ?? false
    return (
      <div style={{ ...pane.setrow, opacity: disabled ? 0.5 : 1 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.rowTitle}>{label}</div>
          <div style={pane.rowSub}>{sub}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={onToggle}
          data-test={opts?.test}
          style={{
            ...pane.toggle,
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: checked ? 'var(--accent)' : 'var(--border-strong)'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: checked ? 17 : 2 }} />
        </button>
      </div>
    )
  }

  return (
    <div style={pane.section}>
      {/* Master switch — off silences every lifecycle notification. */}
      {toggleRow(
        cfg.enabled,
        () => void applyCfg({ ...cfg, enabled: !cfg.enabled }),
        'Desktop notifications',
        'Notify when a terminal agent finishes, needs input, or errors.',
        { test: 'settings-notifications-enabled' }
      )}

      {/* Per-event toggles — nested under the master switch (disabled when it is off). */}
      <div style={styles.group}>
        {EVENTS.map((e) =>
          toggleRow(
            cfg[e.key],
            () => void applyCfg({ ...cfg, [e.key]: !cfg[e.key] }),
            e.title,
            e.sub,
            { disabled: !cfg.enabled, test: `settings-notifications-${e.key}` }
          )
        )}
      </div>

      {/* OS-layer suppression while focused — the toast + on-canvas indicator still fire. */}
      {toggleRow(
        cfg.onlyWhenUnfocused,
        () => void applyCfg({ ...cfg, onlyWhenUnfocused: !cfg.onlyWhenUnfocused }),
        'Only when window unfocused',
        'Skip the OS notification while Expanse is focused. The board still lights up on the canvas.',
        { disabled: !cfg.enabled, test: 'settings-notifications-only-unfocused' }
      )}

      {error && (
        <div role="alert" data-test="settings-notifications-error" style={pane.error}>
          {error}
        </div>
      )}

      <div style={pane.hint}>
        Mute a single board with its <strong>Monitor activity</strong> toggle on the terminal — an
        un-monitored board never notifies, whatever these settings say.
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  // The per-event toggles read as one indented group under the master switch.
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginLeft: 12,
    paddingLeft: 12,
    borderLeft: '1px solid var(--border-subtle)'
  }
}

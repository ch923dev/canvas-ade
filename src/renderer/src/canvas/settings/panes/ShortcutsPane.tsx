/**
 * Shortcuts detail pane — the `shortcuts` section. Rebinds the GLOBAL project-switch hotkey (the
 * OS-wide accelerators MAIN registers via globalShortcut). Immediate-apply, like the recap/voice
 * panes: every change writes through `hotkey.set`, which re-registers and reports which
 * accelerators couldn't bind (already claimed by another app) — surfaced as a warning rather than
 * a silent no-op. "Record" captures the next real chord; Escape cancels a recording.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { HotkeyConfig } from '../../../../../preload'
import { pane } from '../paneStyles'
import { chordFromEvent, pretty } from './accelerator'

// Local default mirroring main `hotkeyConfig.DEFAULT_HOTKEYS` — the pre-load UI state only
// (the persisted value replaces it on mount).
const DEFAULTS: HotkeyConfig = {
  enabled: true,
  next: 'CommandOrControl+Alt+]',
  prev: 'CommandOrControl+Alt+['
}

export function ShortcutsPane(): ReactElement | null {
  const [cfg, setCfg] = useState<HotkeyConfig>(DEFAULTS)
  const [recording, setRecording] = useState<'next' | 'prev' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<string[]>([])

  // Non-electron test runtimes have no hotkey bridge — render nothing (SettingsVoiceSection precedent).
  const hasApi = typeof window !== 'undefined' && !!window.api?.hotkey

  useEffect(() => {
    if (!hasApi) return
    let cancelled = false
    void window.api.hotkey
      .get()
      .then((c) => {
        if (!cancelled && c) setCfg(c)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hasApi])

  const applyCfg = async (next: HotkeyConfig): Promise<void> => {
    const prev = cfg
    setCfg(next)
    setError(null)
    try {
      const r = await window.api.hotkey.set(next)
      if (!r.ok) {
        setCfg(prev)
        setError('Could not save the shortcut — please try again.')
        return
      }
      setFailed(r.failed)
    } catch {
      setCfg(prev)
      setError('Could not save the shortcut — please try again.')
    }
  }

  // Capture the next chord while recording. Escape cancels; a valid chord commits.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return // ignore lone modifiers / no-modifier presses; keep listening
      // Reject a chord that collides with the OTHER direction: globalShortcut can't hold two
      // handlers on one accelerator, so only one would bind and the other would silently do
      // nothing. Surface it instead (reviewer PR #309).
      const other = recording === 'next' ? cfg.prev : cfg.next
      if (chord === other) {
        setRecording(null)
        setError('Next and Previous must use different chords.')
        return
      }
      setRecording(null)
      void applyCfg({ ...cfg, [recording]: chord })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, cfg])

  if (!hasApi) return null

  const bindRow = (which: 'next' | 'prev', label: string): ReactElement => {
    const isRec = recording === which
    return (
      <div style={pane.setrow}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.rowTitle}>{label}</div>
          <div style={{ ...styles.chip, opacity: cfg.enabled ? 1 : 0.5 }}>
            {isRec ? 'Press keys…' : pretty(cfg[which])}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setRecording(isRec ? null : which)}
          disabled={!cfg.enabled}
          style={{ ...pane.syncBtn, ...(cfg.enabled ? null : pane.ctlDisabled) }}
        >
          {isRec ? 'Cancel' : 'Record'}
        </button>
      </div>
    )
  }

  return (
    <div style={pane.section}>
      {/* Enable / disable the whole global hotkey. */}
      <div style={pane.setrow}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.rowTitle}>Global project-switch hotkey</div>
          <div style={pane.rowSub}>
            Cycle projects with a system-wide chord — works even when Expanse is in the background.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg.enabled}
          aria-label="Enable global project-switch hotkey"
          onClick={() => void applyCfg({ ...cfg, enabled: !cfg.enabled })}
          style={{
            ...pane.toggle,
            cursor: 'pointer',
            background: cfg.enabled ? 'var(--accent)' : 'var(--border-subtle)'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: cfg.enabled ? 17 : 2 }} />
        </button>
      </div>

      {bindRow('next', 'Next project')}
      {bindRow('prev', 'Previous project')}

      <button
        type="button"
        onClick={() => void applyCfg({ ...cfg, next: DEFAULTS.next, prev: DEFAULTS.prev })}
        style={styles.reset}
      >
        Reset to defaults
      </button>

      {failed.length > 0 && (
        <div role="alert" style={pane.error}>
          {failed.map(pretty).join(', ')} {failed.length === 1 ? 'is' : 'are'} already in use by
          another app and couldn’t be bound. Pick a different combo.
        </div>
      )}
      {error && (
        <div role="alert" style={pane.error}>
          {error}
        </div>
      )}

      <div style={pane.hint}>
        Use a combo with Ctrl, Alt, or ⌘. A global shortcut is captured system-wide while Expanse is
        running, so avoid chords another app relies on.
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  chip: {
    marginTop: 5,
    display: 'inline-block',
    fontFamily: 'var(--mono)',
    fontSize: 11.5,
    color: 'var(--text)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '3px 8px'
  },
  reset: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontFamily: 'var(--ui)',
    color: 'var(--text-3)',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    textDecoration: 'underline'
  }
}

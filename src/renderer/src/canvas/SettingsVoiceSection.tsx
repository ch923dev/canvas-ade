/**
 * Voice V4 — the Settings › Voice dictation section (SPEC §5; design artifact
 * mock-voice-settings.html, signed off 2026-07-03). Own file so SettingsModal stays under
 * the max-lines ratchet. Every field applies IMMEDIATELY on change (the recap/orchestration
 * toggle pattern — the modal's Save button stays LLM-config-only); MAIN echoes each set()
 * on voice:config:changed, which is what makes the showPill toggle land on the live pill.
 * `autoSendOnFinal` has NO row here — persisted hard-false, reserved (SPEC §2).
 * Renders nothing when `window.api.voice` is absent (non-electron test runtimes).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type {
  VoiceConfigView,
  VoiceDownloadProgress,
  VoiceModelListEntry
} from '../../../preload/voice'
import { codeToToken, defaultHotkey, hotkeyLabel, parseHotkey } from '../voice/hotkey'
import { PROMPT_HISTORY_CAP } from '../store/voiceStore'

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

/** SI megabytes, matching the catalog's published sizes ("71 MB"). */
export function formatMb(bytes: number, decimals = 0): string {
  return `${(bytes / 1_000_000).toFixed(decimals)} MB`
}

/** Accelerator from a capture keydown, or null when it isn't bindable (SPEC §5 hotkey). */
export function accelFromEvent(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  isMac: boolean
): string | null {
  const token = codeToToken(e.code)
  if (token === null) return null // a modifier keydown or a key outside the subset
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null // bare keys must never bind
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push(isMac ? 'Option' : 'Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push(isMac ? 'Cmd' : 'Win')
  parts.push(token)
  return parts.join('+')
}

interface MicDevice {
  deviceId: string
  label: string
}

export function SettingsVoiceSection({
  embedded = false
}: {
  /** When the caller already renders a "Voice" section heading (the Settings tab panel), suppress
   *  this section's own leading divider + "Voice dictation" head so the title isn't doubled. */
  embedded?: boolean
} = {}): ReactElement | null {
  // Absent api (non-electron test runtimes) renders NOTHING — that guard keeps the
  // SettingsModal voice-less unit mocks green. A present api with `supported:false`
  // (win-arm64, V5 gate) renders the section head + one unavailable row instead.
  const supported = window.api?.voice?.supported !== false
  const enabled = !!window.api?.voice && supported
  const [cfg, setCfg] = useState<VoiceConfigView | null>(null)
  const [models, setModels] = useState<VoiceModelListEntry[]>([])
  const [mics, setMics] = useState<MicDevice[]>([])
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hotkeyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    void window.api.voice.config
      .get()
      .then((c) => alive && setCfg(c))
      .catch(() => alive && setCfg(null))
    void window.api.voice.models
      .list()
      .then((m) => alive && setModels(m))
      .catch(() => {})
    // Labels are only populated once the OS mic grant exists (V0's audio-only permission
    // handler); pre-grant we still list the devices with a generic name.
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((ds) => {
        if (!alive) return
        setMics(
          ds
            .filter((d) => d.kind === 'audioinput' && d.deviceId !== '')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
        )
      })
      .catch(() => {})
    const offProgress = window.api.voice.models.onDownloadProgress((p) => setProgress(p))
    return () => {
      alive = false
      offProgress()
    }
  }, [enabled])

  if (!window.api?.voice) return null
  if (!supported) {
    return (
      <>
        {!embedded && (
          <>
            <div style={s.divider} />
            <div style={s.head}>Voice dictation</div>
          </>
        )}
        <div style={s.callout} data-test="voice-unsupported-note" role="note">
          Voice dictation isn&rsquo;t available on this platform yet (Windows on ARM — the on-device
          speech engine has no ARM64 build).
        </div>
      </>
    )
  }

  /** Immediate-apply merge-patch with optimistic UI + revert-on-failure (recap pattern). */
  const setField = (patch: Partial<VoiceConfigView>): void => {
    if (!cfg) return
    const prev = cfg
    // '' clears an optional field in MAIN's repair funnel; mirror that locally.
    const local = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, v === '' ? undefined : v])
    )
    setCfg({ ...cfg, ...local })
    setError(null)
    void window.api.voice.config
      .set(patch)
      .then((r) => {
        if (!r.ok) {
          setCfg(prev)
          setError('Could not save voice settings — please try again.')
        }
      })
      .catch(() => {
        setCfg(prev)
        setError('Could not save voice settings — please try again.')
      })
  }

  const refreshModels = (): void => {
    void window.api.voice.models
      .list()
      .then(setModels)
      .catch(() => {})
  }

  const download = (id: string): void => {
    setDownloadingId(id)
    setProgress(null)
    setError(null)
    void window.api.voice.models
      .download(id)
      .then((r) => {
        if (!r.ok) setError(r.error ?? 'Download failed — please try again.')
      })
      .catch(() => setError('Download failed — please try again.'))
      .finally(() => {
        setDownloadingId(null)
        setProgress(null)
        refreshModels()
      })
  }

  const remove = (id: string): void => {
    setError(null)
    void window.api.voice.models
      .delete(id)
      .then((r) => {
        if (!r.ok) setError(r.error ?? 'Could not delete the model.')
      })
      .catch(() => setError('Could not delete the model.'))
      .finally(refreshModels)
  }

  // The durable ring, guarded — the IPC boundary is untyped; repair guarantees an array, but a
  // partial payload (or a hand-built test mock) must never crash the pane on `.length`.
  const history = cfg?.promptHistory ?? []
  const copyPrompt = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }
  // Delete/clear reuse setField — MAIN repairs + echoes voice:config:changed, so the flyout's
  // Recent mirror re-syncs the moment a prompt is removed here (one store, two surfaces).
  const deletePrompt = (idx: number): void => {
    setField({ promptHistory: history.filter((_, i) => i !== idx) })
  }
  const clearPrompts = (): void => {
    setField({ promptHistory: [] })
  }

  const onHotkeyKeyDown = (e: React.KeyboardEvent): void => {
    if (!armed) return
    e.preventDefault()
    e.stopPropagation()
    if (e.code === 'Escape') {
      setArmed(false)
      return
    }
    const accel = accelFromEvent(e.nativeEvent, IS_MAC)
    if (accel === null) return // a lone modifier / unbindable key — stay armed
    setField({ hotkey: accel })
    setArmed(false)
  }

  const chord = parseHotkey(cfg?.hotkey) ?? parseHotkey(defaultHotkey(IS_MAC))
  const chordParts = chord ? hotkeyLabel(chord, IS_MAC).split('+') : []
  const selected = models.find((m) => m.id === cfg?.modelId)
  const defaultModel = models.find((m) => m.isDefault)

  return (
    <>
      {!embedded && (
        <>
          <div style={s.divider} />
          <div style={s.head}>Voice dictation</div>
        </>
      )}

      <div style={s.setrow} data-test="voice-showpill-row">
        <div style={{ flex: 1 }}>
          <div style={s.rowTitle}>Show voice pill</div>
          <div style={s.rowSub}>
            The floating dictation widget. Applies immediately; hotkey keeps working.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg?.showPill ?? true}
          aria-label="Show voice pill"
          disabled={!cfg}
          data-test="voice-showpill-toggle"
          onClick={() => cfg && setField({ showPill: !cfg.showPill })}
          style={{
            ...s.toggle,
            background: (cfg?.showPill ?? true) ? 'var(--accent)' : 'var(--border-strong)'
          }}
        >
          <span style={{ ...s.toggleKnob, left: (cfg?.showPill ?? true) ? 17 : 2 }} />
        </button>
      </div>

      <label style={s.field}>
        <span style={s.label}>Engine</span>
        <select
          aria-label="Voice engine"
          value={cfg?.engine ?? 'sherpa-onnx'}
          onChange={(e) => setField({ engine: e.target.value as VoiceConfigView['engine'] })}
          style={s.input}
        >
          <option value="sherpa-onnx">Local — sherpa-onnx (on-device)</option>
          <option value="cloud" disabled>
            Cloud — coming soon
          </option>
        </select>
      </label>

      <div style={s.field}>
        <span style={s.label}>Model</span>
        {models.map((m) => {
          const active = m.id === cfg?.modelId
          const isDownloading = downloadingId === m.id
          return (
            <div
              key={m.id}
              data-test={`voice-model-${m.id}`}
              style={{ ...s.model, ...(active ? s.modelActive : null) }}
            >
              <label style={s.modelTop}>
                <input
                  type="radio"
                  name="voice-model"
                  aria-label={`Use ${m.label}`}
                  checked={active}
                  disabled={!cfg}
                  onChange={() => setField({ modelId: m.id })}
                  style={s.radio}
                />
                <span style={s.modelName}>{m.label}</span>
                {m.isDefault && <span style={s.badge}>DEFAULT</span>}
              </label>
              <div style={s.modelMeta}>
                {m.language === 'en' ? 'English' : m.language} · {formatMb(m.totalBytes)} ·{' '}
                {m.license}
              </div>
              {m.licenseNote && <div style={s.modelNote}>{m.licenseNote}</div>}
              <div style={s.modelRow}>
                {m.status === 'ready' ? (
                  <>
                    <span style={s.ready} data-test={`voice-model-ready-${m.id}`}>
                      Downloaded
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="ca-btn-ghost"
                      data-test={`voice-model-delete-${m.id}`}
                      onClick={() => remove(m.id)}
                    >
                      Delete
                    </button>
                  </>
                ) : isDownloading ? (
                  <div style={s.prog} data-test={`voice-model-progress-${m.id}`}>
                    <div style={s.progTrack}>
                      <div
                        style={{
                          ...s.progFill,
                          transform: `scaleX(${progress ? Math.min(1, progress.receivedBytes / progress.totalBytes) : 0.02})`
                        }}
                      />
                    </div>
                    <span style={s.progPct}>
                      {progress
                        ? `${formatMb(progress.receivedBytes, 1)} of ${formatMb(progress.totalBytes, 1)} · file ${progress.fileIndex} of ${progress.fileCount}`
                        : 'starting…'}
                    </span>
                  </div>
                ) : (
                  <>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      style={{
                        ...s.accentBtn,
                        ...(downloadingId !== null ? s.disabled : null)
                      }}
                      disabled={downloadingId !== null}
                      data-test={`voice-model-download-${m.id}`}
                      onClick={() => download(m.id)}
                    >
                      Download {formatMb(m.totalBytes)}
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
        {selected && selected.status === 'absent' && defaultModel && (
          <div style={s.callout} data-test="voice-model-fallback-note" role="note">
            This model isn&rsquo;t downloaded yet — dictation uses {defaultModel.label} until it is.
          </div>
        )}
        <span style={s.hint}>The selected model is used for new dictation sessions.</span>
      </div>

      <label style={s.field}>
        <span style={s.label}>Language</span>
        <select
          aria-label="Dictation language"
          value={cfg?.language ?? 'auto'}
          onChange={(e) => setField({ language: e.target.value })}
          style={s.input}
        >
          <option value="auto">Auto (model default)</option>
          <option value="en">English</option>
        </select>
      </label>

      <label style={s.field}>
        <span style={s.label}>Microphone</span>
        <select
          aria-label="Microphone"
          value={cfg?.micDeviceId ?? ''}
          onChange={(e) => setField({ micDeviceId: e.target.value })}
          style={s.input}
        >
          <option value="">System default</option>
          {mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      <div style={s.field}>
        <span style={s.label}>Dictation hotkey</span>
        <div style={s.hotkeyRow}>
          <div
            ref={hotkeyRef}
            role="button"
            tabIndex={0}
            aria-label="Dictation hotkey"
            data-test="voice-hotkey-field"
            onClick={() => setArmed(true)}
            onKeyDown={(e) => {
              if (!armed && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setArmed(true)
                return
              }
              onHotkeyKeyDown(e)
            }}
            onBlur={() => setArmed(false)}
            style={{ ...s.input, ...s.hotkeyField, ...(armed ? s.hotkeyArmed : null) }}
          >
            {armed ? (
              <span style={s.armedText}>press keys…</span>
            ) : (
              chordParts.map((p, i) => (
                <span key={i} style={s.kbd}>
                  {p}
                </span>
              ))
            )}
          </div>
          <button
            type="button"
            className="ca-btn-ghost"
            data-test="voice-hotkey-reset"
            onClick={() => setField({ hotkey: '' })}
          >
            Reset
          </button>
        </div>
        <span style={s.hint}>
          {armed
            ? 'Esc cancels · must include Ctrl, Alt or Cmd/Win + a key.'
            : 'Click the field, then press a combination. Tap toggles · hold is push-to-talk.'}
        </span>
      </div>

      <div className="vh-sec" data-test="voice-history">
        <div className="vh-hd">
          <span className="vh-title">Prompt history</span>
          {history.length > 0 && (
            <>
              <span className="vh-count" data-test="voice-history-count">
                {history.length} of {PROMPT_HISTORY_CAP} kept
              </span>
              <button
                type="button"
                className="vh-clear"
                data-test="voice-history-clear"
                onClick={clearPrompts}
              >
                Clear all
              </button>
            </>
          )}
        </div>
        <span className="vh-sub">
          Voice prompts you&rsquo;ve sent to a terminal, newest first. Stored on this device only.
        </span>
        {history.length === 0 ? (
          <div className="vh-empty" data-test="voice-history-empty">
            No voice prompts yet &mdash; dictate one and press Send.
          </div>
        ) : (
          <div className="vh-list" data-test="voice-history-list">
            {history.map((text, i) => (
              <div key={i} className="vh-row">
                <span className="vh-text" title={text}>
                  {text}
                </span>
                <button
                  type="button"
                  className="vh-act"
                  aria-label="Copy prompt"
                  title="Copy"
                  onClick={() => copyPrompt(text)}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <rect
                      x="5.5"
                      y="5.5"
                      width="8"
                      height="8"
                      rx="1.6"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                    <path
                      d="M3.5 10.5 H2.8 A1.3 1.3 0 0 1 1.5 9.2 V2.8 A1.3 1.3 0 0 1 2.8 1.5 H9.2 A1.3 1.3 0 0 1 10.5 2.8 V3.5"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="vh-act vh-del"
                  aria-label="Remove prompt"
                  title="Remove"
                  data-test="voice-history-delete"
                  onClick={() => deletePrompt(i)}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div role="alert" data-test="voice-settings-error" style={s.error}>
          {error}
        </div>
      )}
    </>
  )
}

// Mirrors SettingsModal's style grammar (field/label/input/hint + the orchRow/toggle
// shapes) — kept local because the modal doesn't export its style object.
const s: Record<string, CSSProperties> = {
  divider: { height: 1, background: 'var(--border-subtle)', margin: '2px 0' },
  head: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  hint: { fontSize: 11, lineHeight: '15px', color: 'var(--text-3)', fontWeight: 400 },
  input: {
    minHeight: 30,
    padding: '0 9px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--inset)',
    color: 'var(--text)',
    fontSize: 12.5,
    fontFamily: 'var(--ui)'
  },
  error: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--warn)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  callout: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--text-3)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  setrow: {
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '12px 13px',
    display: 'flex',
    alignItems: 'center',
    gap: 12
  },
  rowTitle: { fontSize: 12.5, color: 'var(--text)', fontWeight: 500 },
  rowSub: { fontSize: 11, color: 'var(--text-3)', lineHeight: '15px', marginTop: 2 },
  toggle: {
    position: 'relative',
    width: 36,
    height: 21,
    flex: 'none',
    border: 'none',
    padding: 0,
    borderRadius: 999,
    cursor: 'pointer',
    transition: 'background 0.12s ease-out'
  },
  toggleKnob: {
    position: 'absolute',
    top: 2,
    width: 17,
    height: 17,
    borderRadius: 999,
    background: '#fff',
    transition: 'left 0.12s ease-out'
  },
  model: {
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  modelActive: { borderColor: 'rgba(79,140,255,.4)' },
  modelTop: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  radio: { margin: 0, accentColor: 'var(--accent)' },
  modelName: { fontSize: 12.5, color: 'var(--text)', fontWeight: 500 },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.03em',
    color: 'var(--accent)',
    background: 'var(--accent-wash)',
    border: '1px solid rgba(79,140,255,.4)',
    borderRadius: 4,
    padding: '1px 6px',
    marginLeft: 'auto'
  },
  modelMeta: { fontSize: 11, color: 'var(--text-3)', paddingLeft: 22 },
  modelNote: {
    fontSize: 10.5,
    lineHeight: '14px',
    color: 'var(--text-faint)',
    paddingLeft: 22
  },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 22,
    marginTop: 2,
    minHeight: 24
  },
  ready: {
    fontSize: 11,
    color: 'var(--ok)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5
  },
  accentBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'var(--ui)',
    color: 'var(--accent-hover)',
    border: '1px solid rgba(79,140,255,.4)',
    background: 'var(--accent-wash)',
    borderRadius: 'var(--r-ctl)',
    padding: '4px 10px',
    cursor: 'pointer'
  },
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
  prog: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
  progTrack: {
    height: 4,
    borderRadius: 999,
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    overflow: 'hidden'
  },
  progFill: {
    height: '100%',
    width: '100%',
    background: 'var(--accent)',
    borderRadius: 999,
    transformOrigin: 'left',
    transition: 'transform 0.2s ease-out'
  },
  progPct: { fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-3)' },
  hotkeyRow: { display: 'flex', alignItems: 'center', gap: 6 },
  hotkeyField: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    padding: '4px 9px'
  },
  hotkeyArmed: { borderColor: 'rgba(79,140,255,.45)' },
  armedText: { color: 'var(--text-3)', fontStyle: 'italic', fontSize: 12 },
  kbd: {
    fontSize: 10.5,
    fontFamily: 'var(--mono)',
    color: 'var(--text-2)',
    border: '1px solid var(--border)',
    borderBottomWidth: 2,
    borderRadius: 4,
    padding: '1px 6px',
    background: 'var(--surface)'
  }
}

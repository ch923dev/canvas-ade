/**
 * Settings · Voice · Persona pane (mock-persona-settings.html, user-approved 2026-07-10) —
 * who answers when you talk to Expanse. Persona fields apply IMMEDIATELY (the voice-pane
 * pattern: every change is one jarvis.config.set merge-patch, pushed back live). The API
 * key row is the one explicit-commit control (LlmPane posture: write-only into MAIN) and
 * writes the EXISTING llmKeyStore `anthropic` slot via window.api.llm — no second store.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { pane } from '../paneStyles'
import type { JarvisConfigView } from '../../../../../preload/jarvis'

const TONES: Array<{ id: JarvisConfigView['tonePreset']; name: string; quote: string }> = [
  {
    id: 'butler',
    name: 'Butler, dry wit',
    quote: '“The tests pass, sir. I contained my astonishment.”'
  },
  {
    id: 'mission-control',
    name: 'Mission control',
    quote: '“Spawn confirmed. Two boards running. Standing by.”'
  },
  {
    id: 'pair-programmer',
    name: 'Pair programmer',
    quote: '“Okay so the auth test is the flaky one, want me to rerun it?”'
  },
  { id: 'custom', name: 'Custom', quote: '' }
]

const MODELS = [
  { id: 'claude-opus-4-8', label: 'claude-opus-4-8 (default)' },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5 (fast conversation)' }
]

const seg: CSSProperties = {
  display: 'inline-flex',
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  overflow: 'hidden'
}
const segBtn = (on: boolean): CSSProperties => ({
  fontFamily: 'var(--ui)',
  fontSize: 11,
  padding: '4px 10px',
  border: 0,
  cursor: 'pointer',
  background: on ? 'var(--accent-wash)' : 'transparent',
  color: on ? 'var(--accent-hover)' : 'var(--text-3)'
})
const toneCard = (on: boolean): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  textAlign: 'left',
  cursor: 'pointer',
  background: on ? 'var(--accent-wash)' : 'var(--inset)',
  border: `1px solid ${on ? 'rgba(79,140,255,0.45)' : 'var(--border-subtle)'}`,
  borderRadius: 'var(--r-inner)',
  padding: '9px 11px'
})

function Seg<T extends string>({
  value,
  options,
  onPick,
  testId
}: {
  value: T
  options: Array<{ id: T; label: string }>
  onPick: (v: T) => void
  testId: string
}): ReactElement {
  return (
    <span style={seg} data-test={testId}>
      {options.map((o) => (
        <button key={o.id} style={segBtn(o.id === value)} onClick={() => onPick(o.id)}>
          {o.label}
        </button>
      ))}
    </span>
  )
}

export function PersonaPane(): ReactElement | null {
  const [cfg, setCfg] = useState<JarvisConfigView | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [key, setKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  /** PANE-1 echo suppression: pushes arriving while our own set() round-trips are in
   *  flight are parked (applying them mid-typing would snap the input back a keystroke);
   *  the LAST parked push applies once the in-flight count settles to zero. */
  const inflight = useRef(0)
  const parkedPush = useRef<JarvisConfigView | null>(null)
  /** J5 D3: the wake-word model row (opt-in listener; ~17 MB one-time download). */
  const [kws, setKws] = useState<{
    id: string | null
    label: string
    status: 'ready' | 'absent' | 'unknown'
    pct: number | null
    error: string | null
  }>({ id: null, label: '', status: 'unknown', pct: null, error: null })

  useEffect(() => {
    if (!window.api?.jarvis) return
    let cancelled = false
    void window.api.jarvis
      .status()
      .then((s) => {
        if (cancelled) return
        setCfg(s.config)
        setHasKey(s.hasKey)
        setEncryptionAvailable(s.encryptionAvailable)
      })
      .catch(() => {
        if (!cancelled) setHasKey(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // PANE-1: subscribe the live push — MAIN's repaired values (name fallback, rate clamps)
  // and edits from the panel/other surfaces reach the pane without a remount. The panel
  // header already renders the repaired value; the pane must not diverge from it.
  useEffect(() => {
    if (!window.api?.jarvis) return
    return window.api.jarvis.config.onChanged((next) => {
      if (inflight.current > 0) {
        parkedPush.current = next
        return
      }
      setCfg(next)
    })
  }, [])

  // J5 D3: wake-word model install state + download progress (voice:kws:models catalog).
  useEffect(() => {
    const wake = window.api?.voice?.wake
    if (!wake || window.api.voice.supported === false) return
    let cancelled = false
    void wake.models
      .list()
      .then((l) => {
        if (cancelled || !l[0]) return
        setKws((k) => ({ ...k, id: l[0].id, label: l[0].label, status: l[0].status }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    const wake = window.api?.voice?.wake
    if (!wake || window.api.voice.supported === false) return
    return wake.models.onDownloadProgress((p) => {
      setKws((k) =>
        k.id === p.id
          ? { ...k, pct: Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)) }
          : k
      )
    })
  }, [])

  const downloadKws = async (): Promise<void> => {
    const wake = window.api?.voice?.wake
    if (!wake || !kws.id) return
    setKws((k) => ({ ...k, pct: 0, error: null }))
    try {
      const r = await wake.models.download(kws.id)
      setKws((k) => ({
        ...k,
        pct: null,
        status: r.ok ? 'ready' : k.status,
        error: r.ok ? null : (r.error ?? 'download failed')
      }))
      // The listener reconciles on CONFIG changes only — a wake.start() that declined
      // while the model was absent has nothing to re-arm it once the download lands
      // (found live in the J5 dev check: enable → download → never wakes). Re-assert
      // the flag; the no-op patch round-trips MAIN's jarvis:config:changed push, which
      // useWakeWord treats as the re-arm gesture. MAIN's config is read FRESH here —
      // this closure's `cfg` is stale by a 17 MB download, and a user who toggled the
      // feature OFF mid-download must not have it silently re-enabled (review).
      if (r.ok) {
        const fresh = await window.api.jarvis.config.get().catch(() => null)
        if (fresh?.wakeWordEnabled) {
          void window.api.jarvis.config.set({ wakeWordEnabled: true }).catch(() => {})
        }
      }
    } catch {
      setKws((k) => ({ ...k, pct: null, error: 'download failed' }))
    }
  }

  if (!window.api?.jarvis || !cfg) return null

  /** Immediate-apply merge patch; MAIN repairs + pushes jarvis:config:changed live. */
  const patch = (p: Partial<JarvisConfigView>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    inflight.current++
    void window.api.jarvis.config
      .set(p)
      .catch(() => {})
      .finally(() => {
        inflight.current--
        if (inflight.current === 0 && parkedPush.current) {
          setCfg(parkedPush.current)
          parkedPush.current = null
        }
      })
  }

  const saveKey = async (): Promise<void> => {
    const cleanKey = key.replace(/\s+/g, '') // LlmPane BUG-007(4): strip embedded whitespace
    if (!cleanKey) return
    setKeyBusy(true)
    setKeyError(null)
    try {
      const r = await window.api.llm.setKey({ provider: 'anthropic', key: cleanKey })
      if (!r.ok) {
        setKeyError(
          r.reason === 'encryption-unavailable'
            ? 'No system keyring available to encrypt the key. Set ANTHROPIC_API_KEY instead.'
            : 'Key could not be saved.'
        )
        return
      }
      setKey('')
      setHasKey(true)
    } catch {
      setKeyError('Key could not be saved — please try again.')
    } finally {
      setKeyBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setKeyBusy(true)
    setKeyError(null)
    try {
      const r = await window.api.llm.clearKey({ provider: 'anthropic' })
      if (r.ok) setHasKey(false)
      else setKeyError('Could not clear the key.')
    } catch {
      setKeyError('Could not clear the key.')
    } finally {
      setKeyBusy(false)
    }
  }

  return (
    <div style={pane.section} data-test="persona-pane">
      <div style={pane.setrow}>
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>Show {cfg.name}</div>
          <div style={pane.rowSub}>The right-edge tab; open the panel to talk.</div>
        </div>
        <button
          role="switch"
          aria-checked={cfg.enabled}
          aria-label="Show Jarvis panel"
          onClick={() => patch({ enabled: !cfg.enabled })}
          style={{
            ...pane.toggle,
            background: cfg.enabled ? 'var(--accent)' : 'var(--surface-overlay)',
            cursor: 'pointer'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: cfg.enabled ? 17 : 2 }} />
        </button>
      </div>

      <label style={pane.field}>
        <span style={pane.label}>Name</span>
        <input
          aria-label="Persona name"
          value={cfg.name}
          maxLength={40}
          style={{ ...pane.input, width: 180 }}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <span style={pane.hint}>used in the prompt + panel label</span>
      </label>

      <div style={pane.field}>
        <span style={pane.label}>Tone</span>
        <div
          role="radiogroup"
          aria-label="Tone preset"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}
          data-test="persona-tones"
        >
          {TONES.map((t) => {
            const on = cfg.tonePreset === t.id
            return (
              // A div, not a button: the custom card nests a textarea (invalid inside a button).
              <div
                key={t.id}
                role="radio"
                aria-checked={on}
                tabIndex={0}
                style={toneCard(on)}
                onClick={() => patch({ tonePreset: t.id })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    patch({ tonePreset: t.id })
                  }
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
                  {t.name}
                </span>
                {t.id !== 'custom' ? (
                  <span
                    style={{
                      fontSize: 11,
                      lineHeight: '15px',
                      color: 'var(--text-3)',
                      fontStyle: 'italic'
                    }}
                  >
                    {t.quote}
                  </span>
                ) : (
                  <textarea
                    aria-label="Custom tone"
                    rows={2}
                    disabled={!on}
                    placeholder="Describe the tone in your own words…"
                    value={cfg.customToneText}
                    maxLength={1000}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => patch({ customToneText: e.target.value })}
                    style={{
                      fontFamily: 'var(--ui)',
                      fontSize: 11,
                      lineHeight: '15px',
                      color: 'var(--text-2)',
                      background: 'transparent',
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: 'var(--r-ctl)',
                      padding: '4px 6px',
                      resize: 'none',
                      outline: 'none',
                      marginTop: 2
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <label style={pane.field}>
        <span style={pane.label}>Speaking rate</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input
            aria-label="Speaking rate"
            type="range"
            min={80}
            max={130}
            value={Math.round(cfg.speakingRate * 100)}
            style={{ width: 120, accentColor: 'var(--accent)' }}
            onChange={(e) => patch({ speakingRate: Number(e.target.value) / 100 })}
          />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-2)' }}>
            {cfg.speakingRate.toFixed(2)}×
          </span>
        </span>
        <span style={pane.hint}>
          voice + model download live in Settings › Voice (Speech block)
        </span>
      </label>

      <label style={pane.field}>
        <span style={pane.label}>Verbosity</span>
        <Seg
          value={cfg.verbosity}
          testId="persona-verbosity"
          options={[
            { id: 'concise', label: 'Concise' },
            { id: 'normal', label: 'Normal' },
            { id: 'narrative', label: 'Narrative' }
          ]}
          onPick={(v) => patch({ verbosity: v })}
        />
        <span style={pane.hint}>concise = lead with the answer, one breath per sentence</span>
      </label>

      <label style={pane.field}>
        <span style={pane.label}>Announcements</span>
        <Seg
          value={cfg.announcePolicy}
          testId="persona-announce"
          options={[
            { id: 'all', label: 'All events' },
            { id: 'attention', label: 'Attention only' },
            { id: 'chips-only', label: 'Chips only' }
          ]}
          onPick={(v) => patch({ announcePolicy: v })}
        />
        <span style={pane.hint}>
          what {cfg.name} speaks from agent events (arrives with the Hands update)
        </span>
      </label>

      {window.api?.voice?.wake && window.api.voice.supported !== false && (
        <>
          <div style={pane.setrow}>
            <div style={{ flex: 1 }}>
              <div style={pane.rowTitle}>Wake word — “Hey Jarvis”</div>
              <div style={pane.rowSub}>
                Listens locally for the wake phrase while the panel is closed; hearing it only OPENS
                the panel. No transcription, nothing leaves this machine.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={cfg.wakeWordEnabled}
              aria-label="Enable the wake word"
              data-test="persona-wake-toggle"
              onClick={() => patch({ wakeWordEnabled: !cfg.wakeWordEnabled })}
              style={{
                ...pane.toggle,
                background: cfg.wakeWordEnabled ? 'var(--accent)' : 'var(--surface-overlay)',
                cursor: 'pointer'
              }}
            >
              <span style={{ ...pane.toggleKnob, left: cfg.wakeWordEnabled ? 17 : 2 }} />
            </button>
          </div>
          {cfg.wakeWordEnabled && kws.status !== 'ready' && (
            <div style={pane.row} data-test="persona-wake-model">
              <span style={pane.hint}>
                {kws.pct !== null
                  ? `downloading the listener model… ${kws.pct}%`
                  : `needs the ${kws.label || 'wake-word'} model (~17 MB, one time)`}
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="ca-btn-ghost"
                disabled={kws.pct !== null || !kws.id}
                onClick={() => void downloadKws()}
              >
                Download
              </button>
            </div>
          )}
          {kws.error && (
            <div role="alert" style={pane.error}>
              {kws.error}
            </div>
          )}
        </>
      )}

      <div style={pane.divider} />
      <div style={pane.head}>Brain</div>

      <label style={pane.field}>
        <span style={pane.label}>Model</span>
        <select
          aria-label="Brain model"
          value={cfg.model}
          style={{ ...pane.input, width: 280 }}
          onChange={(e) => patch({ model: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!MODELS.some((m) => m.id === cfg.model) && (
            <option value={cfg.model}>{cfg.model}</option>
          )}
        </select>
      </label>

      <label style={pane.field}>
        <span style={pane.label}>History</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Seg
            value={cfg.historyMode}
            testId="persona-history"
            options={[
              { id: 'project', label: 'Per project' },
              { id: 'session', label: 'Session only' },
              { id: 'off', label: 'Off' }
            ]}
            onPick={(v) => patch({ historyMode: v })}
          />
          <button
            className="ca-btn-ghost"
            onClick={() => void window.api.jarvis.history.clear().catch(() => {})}
          >
            Clear
          </button>
        </span>
        <span style={pane.hint}>
          per project persists under the project&apos;s .canvas/memory/jarvis (asked once per
          project, git-ignored); Clear wipes the open project&apos;s history
        </span>
      </label>

      <label style={pane.field}>
        <span style={pane.label}>
          Anthropic API key {hasKey && <span style={{ color: 'var(--accent)' }}>· set</span>}
        </span>
        <input
          aria-label="Anthropic API key"
          type="password"
          value={key}
          placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'Paste your key'}
          style={pane.input}
          onChange={(e) => setKey(e.target.value)}
        />
        <span style={pane.hint}>
          encrypted via safeStorage, main process only — shared with Context · LLM&apos;s Anthropic
          slot
        </span>
      </label>
      {!encryptionAvailable && (
        <div role="note" style={pane.notice}>
          No system keyring detected — set the <code>ANTHROPIC_API_KEY</code> environment variable
          instead.
        </div>
      )}
      {keyError && (
        <div role="alert" style={pane.error}>
          {keyError}
        </div>
      )}
      <div style={pane.row}>
        <button
          className="ca-btn-ghost"
          disabled={keyBusy || !hasKey}
          onClick={() => void clearKey()}
        >
          Clear key
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="ca-btn-primary"
          disabled={keyBusy || !key}
          onClick={() => void saveKey()}
        >
          Save key
        </button>
      </div>
    </div>
  )
}

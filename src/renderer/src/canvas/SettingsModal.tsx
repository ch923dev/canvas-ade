/**
 * T-B2: the LLM Settings modal. Choose a provider, override its model, optionally enter an
 * API key (masked, write-only into MAIN via llm.setKey — never read back). Portaled to <body>
 * over a scrim, design-token styled (calm/dense, one accent). Provider/model persist via
 * llm.setConfig; the key via llm.setKey; Clear key via llm.clearKey. No multi-key/profiles.
 */
import { useEffect, useId, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_MODELS } from '../lib/llmModels'
import { usePreviewStore } from '../store/previewStore'

const PROVIDERS: Array<{ id: keyof typeof DEFAULT_MODELS; label: string }> = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'local', label: 'Local' }
]

/** T-F6: the env var each provider reads its key from when no keyring is available to encrypt one. */
const ENV_VAR: Record<keyof typeof DEFAULT_MODELS, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'OPENAI_API_KEY'
}

export function SettingsModal({ onClose }: { onClose: () => void }): ReactElement {
  const [provider, setProvider] = useState<keyof typeof DEFAULT_MODELS>('openrouter')
  const [model, setModel] = useState<string>(DEFAULT_MODELS.openrouter)
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  // T-F6: default true so we don't flash a keyring warning before status resolves.
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const menuToken = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)
  useEffect(() => {
    setMenuOpen(menuToken, true)
    return () => setMenuOpen(menuToken, false)
  }, [menuToken, setMenuOpen])

  useEffect(() => {
    // BUG-007(1): without a cancellation flag a slow llm.status() resolving AFTER the user has
    // already edited the provider/model silently clobbers their input back to the persisted values.
    // Mirror the prose-fetch guard pattern: skip the overwrite if the effect was cleaned up.
    let cancelled = false
    void window.api.llm.status().then((s) => {
      if (cancelled) return
      setProvider(s.provider)
      setModel(s.model)
      setHasKey(s.hasKey)
      setEncryptionAvailable(s.encryptionAvailable !== false) // tolerate an older no-field status
      if (s.baseUrl) setBaseUrl(s.baseUrl)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const onProvider = (p: keyof typeof DEFAULT_MODELS): void => {
    setProvider(p)
    setModel(DEFAULT_MODELS[p]) // prefill the cheap/fast default; still editable
    // BUG-007(3): hasKey tracked the load-time provider only, so after a dropdown change the
    // "· set" indicator (and a Clear-key target) stayed stale. Re-fetch the key presence for the
    // newly-selected provider. Guarded against an out-of-order resolve by re-reading current state.
    void window.api.llm.status().then((s) => {
      setHasKey(s.provider === p ? s.hasKey : false)
    })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // BUG-007(2): a non-throwing `{ ok: false }` (e.g. frame-guard 'forbidden', or a rejected
      // baseUrl) would otherwise fall through to setKey + onClose, silently closing the modal as if
      // the (un-persisted) config had saved. Guard on the result before going any further.
      const cr = await window.api.llm.setConfig({
        provider,
        model,
        baseUrl: provider === 'local' && baseUrl ? baseUrl : undefined
      })
      if (!cr.ok) {
        setError('Could not save settings — please try again.')
        return
      }
      // BUG-007(4): strip ALL whitespace (incl. embedded \r\n/tabs from a wrapped paste) before the
      // guard and before storage — `trim()` only removes the ends, so an embedded newline survived
      // and later threw an opaque "invalid header value" on every summarize.
      const cleanKey = key.replace(/\s+/g, '')
      if (cleanKey) {
        const r = await window.api.llm.setKey({ provider, key: cleanKey })
        if (!r.ok) {
          setError(
            r.reason === 'encryption-unavailable'
              ? 'Key not saved: no system keyring available to encrypt it. Provider/model were saved.'
              : 'Key could not be saved.'
          )
          return
        }
      }
      onClose()
    } catch {
      // An IPC rejection (channel gone, main-side throw, teardown race) would otherwise vanish
      // silently and leave the modal looking saved (H1). Surface it so the user can retry.
      setError('Could not save settings — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.llm.clearKey({ provider })
      setHasKey(false)
      setKey('')
    } catch {
      setError('Could not clear the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      // BUG-007(5): while a save is in flight a scrim click is correctly swallowed, but with no
      // visual cue the user re-clicks thinking it failed. Show a 'wait' cursor so the lock is felt.
      style={{ ...styles.scrim, cursor: busy ? 'wait' : 'default' }}
      onPointerDown={() => {
        if (!busy) onClose()
      }}
      data-test="settings-scrim"
    >
      <div
        style={styles.card}
        role="dialog"
        aria-label="LLM settings"
        data-test="settings-modal"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div style={styles.head}>Context brain · LLM</div>

        <label style={styles.field}>
          <span style={styles.label}>Provider</span>
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => onProvider(e.target.value as keyof typeof DEFAULT_MODELS)}
            style={styles.input}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>Model</span>
          <input
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={styles.input}
          />
        </label>

        {provider === 'local' && (
          <label style={styles.field}>
            <span style={styles.label}>Base URL</span>
            <input
              aria-label="Base URL"
              value={baseUrl}
              placeholder="http://127.0.0.1:1234/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              style={styles.input}
            />
          </label>
        )}

        <label style={styles.field}>
          <span style={styles.label}>
            API key {hasKey && <span style={{ color: 'var(--accent)' }}>· set</span>}
          </span>
          <input
            aria-label="API key"
            type="password"
            value={key}
            placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'Paste your key'}
            onChange={(e) => setKey(e.target.value)}
            style={styles.input}
          />
        </label>

        {!encryptionAvailable && provider !== 'local' && (
          <div role="note" data-test="settings-no-keyring" style={styles.notice}>
            No system keyring detected — a key can&apos;t be stored encrypted on this machine. Set
            the <code>{ENV_VAR[provider]}</code> environment variable instead.
          </div>
        )}

        {error && (
          <div role="alert" data-test="settings-error" style={styles.error}>
            {error}
          </div>
        )}

        <div style={styles.row}>
          <button style={styles.ghost} disabled={busy} onClick={() => void clear()}>
            Clear key
          </button>
          <div style={{ flex: 1 }} />
          <button style={styles.ghost} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primary} disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

const styles: Record<string, CSSProperties> = {
  scrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 300,
    background: 'rgba(0,0,0,0.4)',
    display: 'grid',
    placeItems: 'center'
  },
  card: {
    width: 380,
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-ctl)',
    boxShadow: 'var(--shadow-pop)',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  head: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  input: {
    height: 30,
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
  notice: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--text-3)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  ghost: {
    height: 30,
    padding: '0 12px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontSize: 12.5,
    cursor: 'pointer'
  },
  primary: {
    height: 30,
    padding: '0 14px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer'
  }
}

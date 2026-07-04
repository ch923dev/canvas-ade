/**
 * Context · LLM detail pane — the `llm` tile. The one true "form" section: provider / model /
 * (local) base URL / API key / max-calls-per-day, with an explicit Save + Clear-key footer (a key
 * is write-only into MAIN, so it needs a deliberate commit — unlike the immediate-apply toggles).
 * Ported verbatim from `SettingsModal` incl. its guards: BUG-007 (cancel a stale status resolve,
 * guard `{ok:false}`, re-fetch key-presence per provider, strip all whitespace from the key),
 * BUG-029 (guard clear), BUG-031 (IPC rejection → safe no-key default). The app-wide worker cap
 * that used to ride this Save moved to the Orchestration pane (it is not LLM config).
 */
import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_MODELS } from '../../../lib/llmModels'
import { pane } from '../paneStyles'

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

export function LlmPane(): ReactElement {
  const [provider, setProvider] = useState<keyof typeof DEFAULT_MODELS>('openrouter')
  const [model, setModel] = useState<string>(DEFAULT_MODELS.openrouter)
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  // T-F6: default true so we don't flash a keyring warning before status resolves.
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // MCP-05: the per-day LLM call cap (string-backed so the input can be cleared; '' = nothing
  // loaded yet) + a small usage peek (today's calls / the effective cap) read from llm.status().
  const [maxCalls, setMaxCalls] = useState('')
  const [usage, setUsage] = useState<{ calls: number; cap: number } | null>(null)

  useEffect(() => {
    // BUG-007(1): a slow llm.status() resolving AFTER the user edited provider/model would clobber
    // their input back to the persisted values — skip the overwrite if the effect was cleaned up.
    let cancelled = false
    void window.api.llm
      .status()
      .then((s) => {
        if (cancelled) return
        setProvider(s.provider)
        setModel(s.model)
        setHasKey(s.hasKey)
        setEncryptionAvailable(s.encryptionAvailable !== false) // tolerate an older no-field status
        if (s.baseUrl) setBaseUrl(s.baseUrl)
        const cap = s.maxCallsPerDay ?? s.defaultMaxCallsPerDay
        setMaxCalls(cap != null ? String(cap) : '')
        if (s.callsToday != null) setUsage({ calls: s.callsToday, cap: cap ?? 0 })
      })
      .catch(() => {
        // BUG-031: IPC rejection must not produce an unhandledRejection. Safe default: no key.
        if (!cancelled) setHasKey(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onProvider = (p: keyof typeof DEFAULT_MODELS): void => {
    setProvider(p)
    setModel(DEFAULT_MODELS[p]) // prefill the cheap/fast default; still editable
    setSaved(false)
    // BUG-007(3): re-fetch key presence for the newly-selected provider so the "· set" indicator
    // (and the Clear-key target) don't stay stale. Guard the out-of-order resolve by comparing.
    void window.api.llm
      .status()
      .then((s) => {
        setHasKey(s.provider === p ? s.hasKey : false)
      })
      .catch(() => {
        setHasKey(false)
      })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // BUG-007(2): guard the non-throwing `{ok:false}` (frame-guard 'forbidden' / rejected
      // baseUrl) before treating the save as done. MCP-05: persist the cap only when the field is a
      // valid non-negative integer; blank/invalid omits it so MAIN keeps the existing cap.
      const parsedMax = parseInt(maxCalls, 10)
      const cr = await window.api.llm.setConfig({
        provider,
        model,
        baseUrl: provider === 'local' && baseUrl ? baseUrl : undefined,
        maxCallsPerDay: Number.isInteger(parsedMax) && parsedMax >= 0 ? parsedMax : undefined
      })
      if (!cr.ok) {
        setError('Could not save settings — please try again.')
        return
      }
      // BUG-007(4): strip ALL whitespace (incl. embedded \r\n/tabs from a wrapped paste) before the
      // guard and storage — trim() leaves an embedded newline that later throws "invalid header".
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
        setKey('')
        setHasKey(true)
      }
      setSaved(true)
    } catch {
      // An IPC rejection (channel gone, main-side throw, teardown race) would otherwise vanish
      // silently and leave the pane looking saved (H1). Surface it so the user can retry.
      setError('Could not save settings — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // BUG-029: guard on {ok} before clearing UI state (mirrors save). A non-throwing {ok:false}
      // must NOT clear hasKey — the key is still in the keyring and the UI would show false-cleared.
      const r = await window.api.llm.clearKey({ provider })
      if (!r.ok) {
        setError('Could not clear the key — please try again.')
        return
      }
      setHasKey(false)
      setKey('')
    } catch {
      setError('Could not clear the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const dirty = (): void => setSaved(false)

  return (
    <div style={pane.section}>
      <label style={pane.field}>
        <span style={pane.label}>Provider</span>
        <select
          aria-label="Provider"
          value={provider}
          onChange={(e) => onProvider(e.target.value as keyof typeof DEFAULT_MODELS)}
          style={pane.input}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label style={pane.field}>
        <span style={pane.label}>Model</span>
        <input
          aria-label="Model"
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            dirty()
          }}
          style={pane.input}
        />
      </label>

      {provider === 'local' && (
        <label style={pane.field}>
          <span style={pane.label}>Base URL</span>
          <input
            aria-label="Base URL"
            value={baseUrl}
            placeholder="http://127.0.0.1:1234/v1"
            onChange={(e) => {
              setBaseUrl(e.target.value)
              dirty()
            }}
            style={pane.input}
          />
        </label>
      )}

      <label style={pane.field}>
        <span style={pane.label}>
          API key {hasKey && <span style={{ color: 'var(--accent)' }}>· set</span>}
        </span>
        <input
          aria-label="API key"
          type="password"
          value={key}
          placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'Paste your key'}
          onChange={(e) => {
            setKey(e.target.value)
            dirty()
          }}
          style={pane.input}
        />
      </label>

      {!encryptionAvailable && provider !== 'local' && (
        <div role="note" data-test="settings-no-keyring" style={pane.notice}>
          No system keyring detected — a key can&apos;t be stored encrypted on this machine. Set the{' '}
          <code>{ENV_VAR[provider]}</code> environment variable instead.
        </div>
      )}

      <label style={pane.field}>
        <span style={pane.label}>Max LLM calls / day</span>
        <input
          aria-label="Max LLM calls per day"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={maxCalls}
          placeholder="200"
          onChange={(e) => {
            setMaxCalls(e.target.value)
            dirty()
          }}
          style={pane.input}
        />
        {usage && (
          <span style={pane.hint} data-test="settings-usage-peek">
            {usage.calls} of {usage.cap} used today
          </span>
        )}
      </label>

      {error && (
        <div role="alert" data-test="settings-error" style={pane.error}>
          {error}
        </div>
      )}

      <div style={pane.row}>
        <button className="ca-btn-ghost" disabled={busy} onClick={() => void clear()}>
          Clear key
        </button>
        <div style={{ flex: 1 }} />
        {saved && !error && (
          <span style={{ ...pane.hint, color: 'var(--ok)' }} data-test="settings-saved">
            Saved
          </span>
        )}
        <button className="ca-btn-primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}

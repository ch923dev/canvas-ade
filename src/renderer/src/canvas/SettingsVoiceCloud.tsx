/**
 * Phase 2 — Settings › Voice cloud-STT fields (own file so SettingsVoiceSection stays under the
 * max-lines ratchet, mirroring SettingsVoiceTtsSection). Rendered only when engine === 'cloud'.
 * Owns the OpenAI key entry (write-only into the SHARED llm `openai` slot via llm:setKey; the
 * renderer only ever sees presence) and the cloud model field. Keeps the flyout's "set OpenAI
 * key" note (voiceStore.cloudKeyMissing) in sync with key presence while mounted.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { useVoiceStore } from '../store/voiceStore'

export function SettingsVoiceCloud({
  sttModel,
  onModelChange,
  onError
}: {
  sttModel: string
  onModelChange: (value: string) => void
  onError: (message: string | null) => void
}): ReactElement {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.llm
      ?.hasKey({ provider: 'openai' })
      .then((h) => alive && setHasKey(h))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Drive the flyout's "set OpenAI key" note while this pane is mounted; clear it on unmount
  // (engine switched away) so a stale note can't linger.
  useEffect(() => {
    useVoiceStore.getState().setCloudKeyMissing(!hasKey)
    return () => useVoiceStore.getState().setCloudKeyMissing(false)
  }, [hasKey])

  const save = async (): Promise<void> => {
    const clean = key.replace(/\s+/g, '') // strip ALL whitespace (LlmPane BUG-007 discipline)
    if (!clean) return
    setBusy(true)
    onError(null)
    try {
      const r = await window.api.llm.setKey({ provider: 'openai', key: clean })
      if (!r.ok) {
        onError(
          r.reason === 'encryption-unavailable'
            ? 'No system keyring available to encrypt the key. Set OPENAI_API_KEY instead.'
            : 'Key could not be saved.'
        )
        return
      }
      setKey('')
      setHasKey(true)
      setSaved(true)
    } catch {
      onError('Could not save the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    onError(null)
    try {
      const r = await window.api.llm.clearKey({ provider: 'openai' })
      if (!r.ok) {
        onError('Could not clear the key — please try again.')
        return
      }
      setHasKey(false)
      setKey('')
      setSaved(false)
    } catch {
      onError('Could not clear the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label style={s.field}>
        <span style={s.label}>
          OpenAI API key {hasKey && <span style={{ color: 'var(--accent)' }}>· set</span>}
        </span>
        <input
          aria-label="OpenAI API key"
          type="password"
          value={key}
          placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'Paste your OpenAI key'}
          onChange={(e) => {
            setKey(e.target.value)
            setSaved(false)
          }}
          style={s.input}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="ca-btn-ghost"
            disabled={busy || !hasKey}
            onClick={() => void clear()}
          >
            Clear key
          </button>
          <div style={{ flex: 1 }} />
          {saved && (
            <span style={{ ...s.hint, color: 'var(--ok)' }} data-test="voice-openai-key-saved">
              Saved
            </span>
          )}
          <button
            type="button"
            className="ca-btn-primary"
            disabled={busy || key.replace(/\s+/g, '') === ''}
            onClick={() => void save()}
          >
            Save key
          </button>
        </div>
        {!hasKey && (
          <span style={{ ...s.hint, color: 'var(--warn)' }} data-test="voice-openai-key-missing">
            No key set — dictation falls back to the local engine until you add one.
          </span>
        )}
      </label>

      <label style={s.field}>
        <span style={s.label}>Cloud model</span>
        <input
          aria-label="Cloud STT model"
          value={sttModel}
          placeholder="gpt-4o-transcribe"
          onChange={(e) => onModelChange(e.target.value)}
          style={s.input}
        />
        <span style={s.hint}>
          Default gpt-4o-transcribe (the measured pick). Type any OpenAI transcription model id.
        </span>
      </label>
    </>
  )
}

const s: Record<string, CSSProperties> = {
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
  }
}

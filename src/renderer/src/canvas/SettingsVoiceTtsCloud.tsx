/**
 * Phase 3 — Settings › Voice › Speech cloud-TTS fields (own file, mirroring SettingsVoiceCloud so
 * SettingsVoiceTtsSection stays under the max-lines ratchet). Rendered only when ttsEngine ===
 * 'cloud'. Owns the OpenAI key entry (write-only into the SHARED llm `openai` slot via llm:setKey —
 * the SAME key cloud dictation uses; the renderer only ever sees presence), the voice picker, and
 * the cloud model field. Reports key presence up so the section can gate Preview + show the
 * fail-visible "falls back to local" note.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

/** OpenAI's named speech voices. Free-text on disk (a new voice can be hand-set); the picker offers
 *  these plus the current value if it isn't one of them. */
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

export function SettingsVoiceTtsCloud({
  ttsCloudModel,
  ttsVoice,
  onModelChange,
  onVoiceChange,
  onError,
  onKeyPresence
}: {
  ttsCloudModel: string
  ttsVoice: string
  onModelChange: (value: string) => void
  onVoiceChange: (value: string) => void
  onError: (message: string | null) => void
  onKeyPresence: (hasKey: boolean) => void
}): ReactElement {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.llm
      ?.hasKey({ provider: 'openai' })
      .then((h) => {
        if (!alive) return
        setHasKey(h)
        onKeyPresence(h)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // onKeyPresence is a stable setter from the parent; re-running on identity churn is unwanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      onKeyPresence(true)
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
      onKeyPresence(false)
      setKey('')
      setSaved(false)
    } catch {
      onError('Could not clear the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const voiceOptions = VOICES.includes(ttsVoice as (typeof VOICES)[number])
    ? VOICES
    : [ttsVoice, ...VOICES]

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
          <span style={{ ...s.hint, color: 'var(--ok)' }} data-test="tts-openai-key-shared">
            {saved ? 'Saved' : 'Shared with cloud dictation'}
          </span>
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
          <span style={{ ...s.hint, color: 'var(--warn)' }} data-test="tts-openai-key-missing">
            No key set — speech falls back to the local voice until you add one.
          </span>
        )}
      </label>

      <label style={s.field}>
        <span style={s.label}>Voice</span>
        <select
          aria-label="Cloud TTS voice"
          data-test="tts-cloud-voice"
          value={ttsVoice}
          onChange={(e) => onVoiceChange(e.target.value)}
          style={s.input}
        >
          {voiceOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>

      <label style={s.field}>
        <span style={s.label}>Cloud model</span>
        <input
          aria-label="Cloud TTS model"
          value={ttsCloudModel}
          placeholder="gpt-4o-mini-tts"
          onChange={(e) => onModelChange(e.target.value)}
          style={s.input}
        />
        <span style={s.hint}>
          Default gpt-4o-mini-tts (steerable). Type any OpenAI speech model id (tts-1, tts-1-hd).
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

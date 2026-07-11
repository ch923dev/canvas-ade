/**
 * Jarvis J2 — Settings › Voice › Speech (TTS) block, rendered under SettingsVoiceSection
 * in the voice pane. Own file (max-lines ratchet + one purpose per file): the TTS model
 * rows (voice.tts.models.* catalog — download progress push, delete, license notes), the
 * D6 interrupt-mode select, and a Preview button that exercises the full speak pipeline
 * (session start → host synth → chunk stream → playback queue; speaking state flips the
 * button to Stop, which drives the same duck-flush-cancel path as a barge-in).
 * Immediate-apply merge-patch fields, the SettingsVoiceSection pattern. Renders nothing
 * when the tts api is absent or the platform gate is off (the STT section already shows
 * the unavailable row — never doubled here).
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type {
  VoiceConfigView,
  VoiceDownloadProgress,
  VoiceModelListEntry
} from '../../../preload/voice'
import { formatMb } from './SettingsVoiceSection'
import { pane } from './settings/paneStyles'
import { speakText, cancelSpeech } from '../voice/ttsSession'
import { useTtsStore } from '../store/ttsStore'

/** Two sentences → at least two streamed chunks, and enough airtime to try talking over
 *  it (the barge-in drill from the Settings pane). */
const PREVIEW_TEXT =
  'Hi — this is how I will sound. Keep talking over me at any time, and I will stop.'

export function SettingsVoiceTtsSection(): ReactElement | null {
  const supported = window.api?.voice?.supported !== false
  const enabled = !!window.api?.voice?.tts && supported
  const [cfg, setCfg] = useState<VoiceConfigView | null>(null)
  const [models, setModels] = useState<VoiceModelListEntry[]>([])
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const speaking = useTtsStore((s) => s.speaking)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    void window.api.voice.config
      .get()
      .then((c) => alive && setCfg(c))
      .catch(() => alive && setCfg(null))
    void window.api.voice.tts.models
      .list()
      .then((m) => alive && setModels(m))
      .catch(() => {})
    const offProgress = window.api.voice.tts.models.onDownloadProgress((p) => setProgress(p))
    return () => {
      alive = false
      offProgress()
    }
  }, [enabled])

  if (!enabled) return null

  /** Immediate-apply merge-patch with optimistic UI + revert-on-failure (voice pattern). */
  const setField = (patch: Partial<VoiceConfigView>): void => {
    if (!cfg) return
    const prev = cfg
    setCfg({ ...cfg, ...patch })
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
    void window.api.voice.tts.models
      .list()
      .then(setModels)
      .catch(() => {})
  }

  const download = (id: string): void => {
    setDownloadingId(id)
    setProgress(null)
    setError(null)
    void window.api.voice.tts.models
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
    void window.api.voice.tts.models
      .delete(id)
      .then((r) => {
        if (!r.ok) setError(r.error ?? 'Could not delete the model.')
      })
      .catch(() => setError('Could not delete the model.'))
      .finally(refreshModels)
  }

  const preview = (): void => {
    setError(null)
    void speakText(PREVIEW_TEXT).then((ok) => {
      if (!ok) setError('Could not start speech — is the selected voice downloaded?')
    })
  }

  const selected = models.find((m) => m.id === cfg?.ttsModelId)
  const selectedReady = selected?.status === 'ready'

  return (
    <>
      <div style={pane.divider} />
      <div style={pane.head}>Speech — Jarvis voice</div>

      <div style={pane.field}>
        <span style={pane.label}>Voice model</span>
        {models.map((m) => {
          const active = m.id === cfg?.ttsModelId
          const isDownloading = downloadingId === m.id
          return (
            <div
              key={m.id}
              data-test={`tts-model-${m.id}`}
              style={{ ...s.model, ...(active ? s.modelActive : null) }}
            >
              <label style={s.modelTop}>
                <input
                  type="radio"
                  name="voice-tts-model"
                  aria-label={`Use ${m.label}`}
                  checked={active}
                  disabled={!cfg}
                  onChange={() => setField({ ttsModelId: m.id })}
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
                    <span style={s.ready} data-test={`tts-model-ready-${m.id}`}>
                      Downloaded
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="ca-btn-ghost"
                      data-test={`tts-model-delete-${m.id}`}
                      onClick={() => remove(m.id)}
                    >
                      Delete
                    </button>
                  </>
                ) : isDownloading ? (
                  <div style={s.prog} data-test={`tts-model-progress-${m.id}`}>
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
                        ...pane.syncBtn,
                        ...(downloadingId !== null ? pane.ctlDisabled : null)
                      }}
                      disabled={downloadingId !== null}
                      data-test={`tts-model-download-${m.id}`}
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
        <span style={pane.hint}>
          Shared pronunciation data downloads once and is reused by both voices.
        </span>
      </div>

      <div style={pane.setrow} data-test="tts-preview-row">
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>Preview voice</div>
          <div style={pane.rowSub}>
            Speaks a short line through the selected voice. Talk over it to test barge-in.
          </div>
        </div>
        {speaking ? (
          <button
            type="button"
            className="ca-btn-ghost"
            data-test="tts-stop"
            onClick={() => void cancelSpeech()}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            style={{ ...pane.syncBtn, ...(!selectedReady ? pane.ctlDisabled : null) }}
            disabled={!selectedReady}
            data-test="tts-preview"
            onClick={preview}
          >
            Preview
          </button>
        )}
      </div>

      <label style={pane.field}>
        <span style={pane.label}>Interrupting Jarvis</span>
        <select
          aria-label="Interrupt mode"
          data-test="tts-duplex"
          value={cfg?.ttsDuplex ?? 'full'}
          onChange={(e) => setField({ ttsDuplex: e.target.value as VoiceConfigView['ttsDuplex'] })}
          style={pane.input}
        >
          <option value="full">Voice interrupt — mic stays live while it speaks</option>
          <option value="half">Push louder — mic muted while it speaks (echo-prone setups)</option>
        </select>
        <span style={pane.hint}>
          If Jarvis keeps cutting itself off on speakers (its own voice leaking into the mic),
          switch to the muted-mic mode.
        </span>
      </label>

      {error && (
        <div role="alert" data-test="tts-settings-error" style={pane.error}>
          {error}
        </div>
      )}
    </>
  )
}

// Model-row grammar mirrored from SettingsVoiceSection's private copy (it doesn't export
// its style object; paneStyles carries the shared field/row/button shapes used above).
const s: Record<string, CSSProperties> = {
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
  progPct: { fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-3)' }
}

/**
 * Voice V3 — the review flyout (SPEC §3: review-first lives HERE). A compact panel
 * anchored above the pill (flips below near the top edge) that opens only when there is
 * a transcript to review or a state needing attention. Carries the target row (→ board
 * title, bound to the canvas selection), the editable transcript with the dimmed-italic
 * partial tail (a metrics-identical mirror renders the tail behind a transparent-backed
 * textarea — a textarea cannot style a span), Insert/Send, and the attention rows
 * (`no-target` / `model-missing` + Download / `mic-denied`).
 *
 * Injection contract (the product invariants): Send = bracketed paste via the registry,
 * then ONE discrete `\r` as its own port write after ~150 ms settle, re-checking
 * `running[id]` at fire time. Insert = paste only. Send is the ONLY `\r` emitter;
 * `autoSendOnFinal` stays hard-false — no code path here submits without a user gesture.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useVoiceStore, joinFinal, pushHistory } from '../store/voiceStore'
import { useCanvasStore } from '../store/canvasStore'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import { getTerminalInput } from '../canvas/boards/terminal/terminalInputRegistry'
import { startVoice, stopVoice } from './voiceSession'
import type { PillPos } from './VoicePill'

const FLYOUT_W = 400
const GAP = 6
const MARGIN = 8
/** Anchor above the pill unless it sits this close to the top edge — then flip below. */
const FLIP_BELOW_Y = 280
/** Paste → submit settle (the Claude Code TUI submit discipline, mcpOrchestrator.ts). */
export const SUBMIT_SETTLE_MS = 150
/** ~6 rows of 17px mono line-height before the transcript scrolls (SubmitWell pattern). */
const MAX_INPUT_PX = 112
/** How many recent prompts the flyout shows inline; the full ring lives in Settings › Voice. */
const RECENT_VISIBLE = 8

/** Map a cloud transcribe error reason (openaiTranscribe.TranscribeErrorReason) to a short,
 *  fail-visible line. Unknown reasons fall back to a generic message rather than leaking codes. */
function cloudErrorMessage(reason: string): string {
  switch (reason) {
    case 'no-key':
      return 'No OpenAI key set'
    case 'unauthorized':
      return 'OpenAI rejected the key'
    case 'quota':
      return 'OpenAI quota exhausted'
    case 'rate-limited':
      return 'OpenAI rate limit — try again'
    case 'timeout':
      return 'Transcription timed out'
    case 'server':
      return 'OpenAI service error — try again'
    default:
      return 'Transcription failed'
  }
}

interface DlState {
  receivedBytes: number
  totalBytes: number
}

/**
 * Inject the current transcript into the target terminal. Exported for the unit tests
 * (mocked registry): paste carries the EXACT text; `submit` (Send only) fires as its own
 * later write, never concatenated into the paste. Resolves once the paste landed (the
 * submit timer keeps running behind it).
 */
export async function injectTranscript(targetId: string, submit: boolean): Promise<boolean> {
  if (!useTerminalRuntimeStore.getState().running[targetId]) return false
  // Stop first: the stop round-trip folds a provisional tail into the draft (and the eos
  // drain guarantees that happened before the invoke resolves), so the bytes we paste are
  // exactly the bytes the user saw solidify.
  if (useVoiceStore.getState().capturing) await stopVoice()
  const s = useVoiceStore.getState()
  const text = joinFinal(s.draft, s.partial)
  if (!text.trim()) return false
  const entry = getTerminalInput(targetId)
  if (!entry) return false
  entry.paste(text)
  s.clearTranscript()
  s.setFlyoutOpen(false)
  if (submit) {
    // Record the SENT prompt in the durable history ring — Insert never records (a paste is
    // not a submitted prompt). Optimistic mirror update + persist; MAIN repairs/caps and
    // echoes voice:config:changed, which re-syncs the mirror across the flyout AND Settings.
    const next = pushHistory(s.recent, text)
    if (next !== s.recent) {
      s.setRecent(next)
      void window.api?.voice?.config.set({ promptHistory: next }).catch(() => {})
    }
    window.setTimeout(() => {
      // Re-check at fire time — the PTY may have died during the settle.
      if (useTerminalRuntimeStore.getState().running[targetId]) {
        getTerminalInput(targetId)?.submit()
      }
    }, SUBMIT_SETTLE_MS)
  }
  return true
}

export function VoiceFlyout({ anchor }: { anchor: PillPos | null }): ReactElement | null {
  const open = useVoiceStore((s) => s.flyoutOpen)
  const draft = useVoiceStore((s) => s.draft)
  const partial = useVoiceStore((s) => s.partial)
  const capturing = useVoiceStore((s) => s.capturing)
  const micSilent = useVoiceStore((s) => s.micSilent)
  const micStatus = useVoiceStore((s) => s.micStatus)
  const modelStatus = useVoiceStore((s) => s.modelStatus)
  const engineError = useVoiceStore((s) => s.engineError)
  const transcribing = useVoiceStore((s) => s.transcribing)
  const cloudError = useVoiceStore((s) => s.cloudError)
  const cloudKeyMissing = useVoiceStore((s) => s.cloudKeyMissing)
  const setDraft = useVoiceStore((s) => s.setDraft)
  const setFlyoutOpen = useVoiceStore((s) => s.setFlyoutOpen)
  const setCloudError = useVoiceStore((s) => s.setCloudError)
  const recent = useVoiceStore((s) => s.recent)
  // Target = the selected TERMINAL board (primitive selectors — no fresh-object churn).
  const targetId = useCanvasStore((s) => {
    const b = s.boards.find((x) => x.id === s.selectedId)
    return b && b.type === 'terminal' ? b.id : null
  })
  const targetTitle = useCanvasStore((s) => {
    const b = s.boards.find((x) => x.id === s.selectedId)
    return b && b.type === 'terminal' ? b.title : ''
  })
  const running = useTerminalRuntimeStore((s) => (targetId ? !!s.running[targetId] : false))

  const taRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [modelMeta, setModelMeta] = useState<{ id: string; label: string; mb: number } | null>(null)
  const [dl, setDl] = useState<DlState | null>(null)
  const [dlError, setDlError] = useState<string | null>(null)
  // Phase 2: the configured cloud STT model, shown in the transcribing hint (cosmetic).
  const [sttModel, setSttModel] = useState('')
  // Recent (prompt history) — collapsed by default; opens on click. Shows a slice of the
  // durable ring inline; the full list lives in Settings › Voice.
  const [recentOpen, setRecentOpen] = useState(false)

  const denied = micSilent || micStatus === 'denied'
  const showError = !denied && engineError
  const modelMissing = !denied && modelStatus === 'absent'
  // A cloud transcribe error takes the header slot below engine-crash/model-missing but keeps
  // the composer live (the draft is preserved and still sendable). Dismissible.
  const showCloudError = !denied && !showError && !modelMissing && !!cloudError
  const hasText = (draft + partial).trim().length > 0
  // Never inject mid-transcription — the batch final is still in flight.
  const canInject = !!targetId && running && hasText && !transcribing

  // Auto-grow off the MIRROR (it includes the partial tail, so the box grows with the
  // dictation), capped at ~6 rows; keep the tail visible while listening.
  useEffect(() => {
    const ta = taRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return
    ta.style.height = 'auto'
    const h = Math.min(Math.max(ta.scrollHeight, mirror.scrollHeight), MAX_INPUT_PX)
    ta.style.height = `${h}px`
    if (capturing) ta.scrollTop = ta.scrollHeight
    mirror.scrollTop = ta.scrollTop
  }, [draft, partial, capturing, open])

  // Lazy-load the default model's label/size for the model-missing row.
  useEffect(() => {
    if (!open || !modelMissing || modelMeta) return
    let alive = true
    void window.api.voice.models
      .list()
      .then((l) => {
        const m = l.find((x) => x.isDefault)
        if (alive && m) {
          setModelMeta({ id: m.id, label: m.label, mb: Math.round(m.totalBytes / 1e6) })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, modelMissing, modelMeta])

  // Phase 2: the cloud STT model name for the transcribing hint (cosmetic; cheap one-shot).
  useEffect(() => {
    const getConfig = window.api?.voice?.config?.get
    if (!open || sttModel || !getConfig) return
    let alive = true
    void getConfig()
      .then((c) => {
        if (alive) setSttModel(c.sttModel)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, sttModel])

  if (!open || !anchor) return null

  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(Math.max(anchor.x, MARGIN), Math.max(MARGIN, vw - FLYOUT_W - MARGIN))
  const place =
    anchor.y > FLIP_BELOW_Y ? { bottom: vh - anchor.y + GAP } : { top: anchor.y + 34 + GAP } // below the pill near the top edge

  const doDownload = async (): Promise<void> => {
    if (!modelMeta || dl) return
    setDlError(null)
    setDl({ receivedBytes: 0, totalBytes: modelMeta.mb * 1e6 })
    const unsub = window.api.voice.models.onDownloadProgress((p) =>
      setDl({ receivedBytes: p.receivedBytes, totalBytes: p.totalBytes })
    )
    const r = await window.api.voice.models.download(modelMeta.id)
    unsub()
    setDl(null)
    if (r.ok) {
      useVoiceStore.getState().setModelStatus('ready')
      // Pick the model up mid-session: the running session was started paths-less
      // (count-only), so cycle it once — the next partials are real.
      if (useVoiceStore.getState().capturing) {
        await stopVoice()
        void startVoice()
      }
    } else {
      setDlError(r.error ?? 'download failed')
    }
  }

  // Reuse a past prompt: drop it into the composer and focus so the user can edit/Send at once.
  const reuseRecent = (text: string): void => {
    setDraft(text)
    requestAnimationFrame(() => taRef.current?.focus())
  }
  const copyRecent = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }
  // Bridge to the full history in Settings › Voice. VoicePill mounts in App — a sibling of
  // AppChrome, which owns the Settings panel — so a decoupled window event carries the intent.
  const openVoiceSettings = (): void => {
    window.dispatchEvent(new CustomEvent('expanse:open-settings', { detail: { section: 'voice' } }))
    setFlyoutOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canInject) void injectTranscript(targetId, true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // First Esc stops listening; the next closes (draft kept) — SPEC §3.
      if (useVoiceStore.getState().capturing) void stopVoice()
      else setFlyoutOpen(false)
    }
  }

  const hint = capturing ? (
    <span className="vf-hint">
      <b>Enter</b> send · <b>Shift+Enter</b> newline · <b>Esc</b> stop
    </span>
  ) : (
    <span className="vf-hint">
      <b>Enter</b> send · <b>Shift+Enter</b> newline · <b>Esc</b> close
    </span>
  )

  return (
    <div className="voice-flyout" style={{ left, ...place }} data-test="voice-flyout">
      {denied ? (
        <div className="vf-note" data-test="voice-flyout-denied">
          <span className="vf-sdot" style={{ background: 'var(--err)' }} />
          <span className="vf-grow">
            Microphone blocked by the OS
            <span className="vf-meta"> allow Expanse in system privacy settings, then retry</span>
          </span>
          <button className="vf-x" title="Close" onClick={() => setFlyoutOpen(false)}>
            ×
          </button>
        </div>
      ) : modelMissing ? (
        <div className="vf-note" data-test="voice-flyout-model">
          <span className="vf-sdot" style={{ background: 'var(--warn)' }} />
          <span className="vf-grow">
            Voice model not downloaded
            <span className="vf-meta">
              {' '}
              {modelMeta ? `${modelMeta.label} · ${modelMeta.mb} MB` : '…'}
              {dlError ? ` — ${dlError}` : ''}
            </span>
            {dl && (
              <span className="vf-progress">
                <i
                  style={{
                    width: `${Math.min(100, Math.round((dl.receivedBytes / Math.max(1, dl.totalBytes)) * 100))}%`
                  }}
                />
              </span>
            )}
          </span>
          {!dl && (
            <button className="vf-btn primary" onClick={() => void doDownload()}>
              Download
            </button>
          )}
          <button className="vf-x" title="Close" onClick={() => setFlyoutOpen(false)}>
            ×
          </button>
        </div>
      ) : (
        <>
          {showError ? (
            // SPEC §3 `error`: the engine crashed past its restart budget. The row takes
            // the header slot only — the draft below stays editable AND sendable (Send
            // needs just the terminal registry, not the engine).
            <div className="vf-note" data-test="voice-flyout-error">
              <span className="vf-sdot" style={{ background: 'var(--err)' }} />
              <span className="vf-grow">
                Voice engine crashed
                <span className="vf-meta"> your draft is preserved — restart to dictate more</span>
              </span>
              <button
                className="vf-btn primary"
                data-test="voice-flyout-restart"
                onClick={() => {
                  useVoiceStore.getState().setEngineError(false)
                  void startVoice()
                }}
              >
                Restart
              </button>
              <button
                className="vf-x"
                title="Close (draft kept)"
                onClick={() => setFlyoutOpen(false)}
              >
                ×
              </button>
            </div>
          ) : showCloudError ? (
            // Phase 2: a fail-visible cloud transcribe error. Header slot only — the composer
            // below stays editable + sendable (the draft is untouched). Dismissible.
            <div className="vf-note" data-test="voice-flyout-cloud-error">
              <span className="vf-sdot" style={{ background: 'var(--err)' }} />
              <span className="vf-grow">
                {cloudErrorMessage(cloudError!)}
                <span className="vf-meta">
                  {' '}
                  draft preserved
                  {cloudError === 'no-key' ||
                  cloudError === 'unauthorized' ||
                  cloudError === 'quota'
                    ? ' · check Settings › Voice'
                    : ''}
                </span>
              </span>
              <button
                className="vf-x"
                title="Dismiss (draft kept)"
                data-test="voice-flyout-cloud-error-dismiss"
                onClick={() => setCloudError(null)}
              >
                ×
              </button>
            </div>
          ) : targetId && running ? (
            <div className="vf-hd">
              <span className="vf-to">to</span>
              <span className="vf-target" data-test="voice-flyout-target">
                → <b>{targetTitle || 'Terminal'}</b>
              </span>
              <button
                className="vf-x"
                title="Close (draft kept)"
                onClick={() => setFlyoutOpen(false)}
              >
                ×
              </button>
            </div>
          ) : (
            <div className="vf-note" data-test="voice-flyout-notarget">
              <span className="vf-sdot" style={{ background: 'var(--warn)' }} />
              <span className="vf-grow">
                No running terminal selected
                <span className="vf-meta">
                  {' '}
                  click a terminal board to target it — draft is kept
                </span>
              </span>
              <button
                className="vf-x"
                title="Close (draft kept)"
                onClick={() => setFlyoutOpen(false)}
              >
                ×
              </button>
            </div>
          )}
          {hasText || targetId || transcribing ? (
            <div className="vf-body">
              {/* Phase 2: cloud selected but no key — dictation ran locally; nudge to Settings.
                  A slim non-blocking strip (the target row + composer stay usable). */}
              {cloudKeyMissing && !transcribing && (
                <button
                  type="button"
                  className="vf-cloud-nokey"
                  data-test="voice-flyout-cloud-nokey"
                  onClick={openVoiceSettings}
                  title="Set your OpenAI key in Settings › Voice"
                >
                  <span className="vf-sdot" style={{ background: 'var(--warn)' }} />
                  Cloud STT needs an OpenAI key — using local · Settings →
                </button>
              )}
              <div className="vf-text">
                <div className="vf-mirror" aria-hidden ref={mirrorRef}>
                  <span className="vf-ghost">{draft}</span>
                  {partial && (
                    // Edge-trimmed like joinFinal will commit it — a raw sherpa partial
                    // can lead with a space, which would render as a stray indent.
                    <span className="vf-partial" data-test="voice-flyout-partial">
                      {(draft && !/\s$/.test(draft) ? ' ' : '') + partial.trim()}
                    </span>
                  )}
                  {/* Phase 2: cloud batch gap (no partials) — a calm pulsing dot + label. */}
                  {transcribing && (
                    <span className="vf-transcribing" data-test="voice-flyout-transcribing">
                      {draft && !/\s$/.test(draft) ? ' ' : ''}
                      <span className="vf-tdot" />
                      transcribing…
                    </span>
                  )}
                  {capturing && <span className="vf-caret" />}
                </div>
                <textarea
                  ref={taRef}
                  className="vf-input"
                  data-test="voice-flyout-input"
                  value={draft}
                  rows={1}
                  spellCheck={false}
                  // No placeholder once a tail exists: the placeholder paints in the same
                  // box the mirror's partial renders behind — they'd overlap-garble.
                  placeholder={capturing && !partial ? 'listening…' : ''}
                  onChange={(e) => setDraft(e.target.value)}
                  onScroll={() => {
                    if (mirrorRef.current && taRef.current) {
                      mirrorRef.current.scrollTop = taRef.current.scrollTop
                    }
                  }}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div className="vf-actions">
                {transcribing ? (
                  <span className="vf-hint" data-test="voice-flyout-transcribing-hint">
                    {sttModel || 'cloud'} · ~1s
                  </span>
                ) : (
                  hint
                )}
                <button
                  className="vf-btn"
                  data-test="voice-flyout-insert"
                  disabled={!canInject}
                  title="Paste into the terminal without submitting"
                  onClick={() => targetId && void injectTranscript(targetId, false)}
                >
                  Insert
                </button>
                <button
                  className="vf-btn primary"
                  data-test="voice-flyout-send"
                  disabled={!canInject}
                  title="Paste + submit (one Enter)"
                  onClick={() => targetId && void injectTranscript(targetId, true)}
                >
                  Send ⏎
                </button>
              </div>
            </div>
          ) : null}
          {recent.length > 0 && (
            <div className={`vf-recent${recentOpen ? ' open' : ''}`} data-test="voice-recent">
              <button
                type="button"
                className="vf-recent-hd"
                aria-expanded={recentOpen}
                data-test="voice-recent-toggle"
                onClick={() => setRecentOpen((o) => !o)}
              >
                <span className="vf-chev" aria-hidden>
                  <svg width="9" height="9" viewBox="0 0 10 10">
                    <path
                      d="M3 1.5 L7 5 L3 8.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="vf-recent-lbl">Recent</span>
                <span className="vf-recent-count">({recent.length})</span>
                {recent.length > RECENT_VISIBLE && (
                  <span className="vf-recent-more">+{recent.length - RECENT_VISIBLE} more</span>
                )}
              </button>
              {recentOpen && (
                <>
                  <div className="vf-recent-list" data-test="voice-recent-list">
                    {recent.slice(0, RECENT_VISIBLE).map((text, i) => (
                      <div key={i} className="vf-recent-row">
                        <button
                          type="button"
                          className="vf-recent-reuse"
                          data-test="voice-recent-reuse"
                          title={`Reuse: ${text}`}
                          onClick={() => reuseRecent(text)}
                        >
                          {text}
                        </button>
                        <button
                          type="button"
                          className="vf-recent-copy"
                          aria-label="Copy prompt"
                          title="Copy"
                          onClick={() => copyRecent(text)}
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
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
                      </div>
                    ))}
                  </div>
                  <div className="vf-recent-foot">
                    <span>click a prompt to reuse</span>
                    <button
                      type="button"
                      className="vf-recent-all"
                      data-test="voice-recent-all"
                      onClick={openVoiceSettings}
                    >
                      See all in Settings →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

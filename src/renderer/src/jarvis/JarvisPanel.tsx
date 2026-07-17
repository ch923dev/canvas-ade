/**
 * Jarvis panel — the surface revision (mock-jarvis-panel.html rev 1, user-approved
 * 2026-07-13; KICKOFF-PANEL.md). The floating island + transcript tail RETIRED; Jarvis is
 * a right-docked panel (Context/Library family) with a collapsed edge tab (static 18px
 * mini core + unread badge). THE MIC-GATE IS STRUCTURAL: converse mode can only arm while
 * this panel is open (jarvisSession refuses otherwise), and every close path — ✕, Esc,
 * hotkey, project close/unmount — runs the full converse teardown. If you can't see the
 * conversation, it can't hear you. Speaking is NOT gated (announcements need no mic).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useJarvisStore, type JarvisActRow, type JarvisDisplayTurn } from '../store/jarvisStore'
import { useTtsStore } from '../store/ttsStore'
import { useVoiceStore } from '../store/voiceStore'
import { useAttentionStore, type AttentionKind } from '../store/attentionStore'
import { useCanvasStore } from '../store/canvasStore'
import { speakText } from '../voice/ttsSession'
import { startNeuralCore, paintNeuralCoreFrame, type CoreMode } from './neuralCore'
import {
  closeJarvisPanel,
  openJarvisPanel,
  sendComposingNow,
  toggleConverse,
  toggleJarvisPanel,
  useJarvisController
} from './jarvisSession'
import { useWakeWord } from './useWakeWord'

/** Header core = the island core scaled up; edge-tab mini core (mock exhibits B/C). */
const HEADER_CORE_PX = 44
const TAB_CORE_PX = 18

/** Renderer mirror of MAIN's HISTORY_PROMPT_WINDOW (jarvisPersona.ts — duplicated across
 *  the bundle boundary, the JarvisConfigView discipline): turns beyond it fell out of the
 *  model's window, which the history chip states honestly (J5 adds real summarization). */
const HISTORY_WINDOW = 24

const IS_MAC = navigator.platform.toLowerCase().includes('mac')
/** The panel+mic toggle chord (⌃⇧J family — checked free against the shortcut registry:
 *  voice dictation holds Ctrl/Cmd+Shift+M, the side panel Ctrl/Cmd+Shift+B). */
const HOTKEY_LABEL = IS_MAC ? '⌘⇧J' : 'Ctrl+Shift+J'
const matchesPanelHotkey = (e: KeyboardEvent): boolean =>
  e.code === 'KeyJ' &&
  e.shiftKey &&
  !e.altKey &&
  (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)

export function deriveCoreMode(s: {
  converse: boolean
  speaking: boolean
  streaming: boolean
  awaiting: boolean
  capturing: boolean
  /** J4: a turn-act awaits its ✓/✗ (or a tool is executing) — the 'acting' arc wins. */
  acting?: boolean
}): CoreMode {
  if (!s.converse) return 'idle'
  if (s.acting) return 'acting'
  if (s.speaking || s.streaming) return 'speaking'
  if (s.awaiting) return 'thinking'
  if (s.capturing) return 'listening'
  return 'idle'
}

function dayLabel(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const yd = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'today'
  if (d.toDateString() === yd.toDateString()) return 'yesterday'
  return d.toLocaleDateString()
}

function timeLabel(at: number): string {
  return at > 0
    ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : ''
}

/** D8 chip copy per attention kind (the useNotifications toast verbs, chip-sized). */
const EVENT_MSG: Record<AttentionKind, string> = {
  done: 'Agent finished',
  'needs-input': 'Agent needs your input',
  error: 'Agent hit an error'
}

/** D8 spoken-announce copy — grounded in the EVENT (board title + kind), nothing else. */
const ANNOUNCE_MSG: Record<AttentionKind, string> = {
  done: 'finished',
  'needs-input': 'needs your input',
  error: 'hit an error'
}

/** A RESOLVED turn-act chip (mock rev 2 exhibit F rows 3–4). */
function ActChip({ act }: { act: JarvisActRow }): ReactElement {
  const mark = act.phase === 'ok' ? '✓' : act.phase === 'denied' ? '✗' : '⚠'
  const cls = act.phase === 'ok' ? ' ok' : act.phase === 'denied' ? ' denied' : ' err'
  return (
    <div className={`jp-act${cls}`} data-test="jarvis-act-chip" data-phase={act.phase}>
      {mark} {act.summary}
      {act.phase === 'denied' && ' — nothing changed'}
    </div>
  )
}

export function JarvisPanel(): ReactElement | null {
  // Same gate as the island had: no jarvis preload (non-electron test runtimes) or the
  // win-arm64 voice gate ⇒ the whole surface stays dormant.
  const enabled = !!window.api?.jarvis && window.api.voice?.supported !== false
  const panelOpen = useJarvisStore((s) => s.panelOpen)
  const converse = useJarvisStore((s) => s.converseMode)
  const awaiting = useJarvisStore((s) => s.awaitingReply)
  const activeTurnId = useJarvisStore((s) => s.activeTurnId)
  const streamText = useJarvisStore((s) => s.streamText)
  const lastUserText = useJarvisStore((s) => s.lastUserText)
  const turns = useJarvisStore((s) => s.turns)
  const acts = useJarvisStore((s) => s.acts)
  const pendingConfirm = useJarvisStore((s) => s.pendingConfirm)
  const lastError = useJarvisStore((s) => s.lastError)
  const personaName = useJarvisStore((s) => s.personaName)
  const speechReady = useJarvisStore((s) => s.speechReady)
  const composing = useJarvisStore((s) => s.composing)
  const listenMode = useJarvisStore((s) => s.listenMode)
  const ttsSpeaking = useTtsStore((s) => s.speaking)
  const capturing = useVoiceStore((s) => s.capturing)
  const partial = useVoiceStore((s) => s.partial)
  const micStatus = useVoiceStore((s) => s.micStatus)
  const micSilent = useVoiceStore((s) => s.micSilent)
  const attention = useAttentionStore((s) => s.byId)
  // Subscribed (not getState) so a board retitle re-renders the D8 chips (NIT-2).
  const boards = useCanvasStore((s) => s.boards)

  const [show, setShow] = useState(true)
  const [toneMeta, setToneMeta] = useState('butler')
  const [announcePolicy, setAnnouncePolicy] = useState<'all' | 'attention' | 'chips-only'>(
    'chips-only'
  )
  const coreRef = useRef<HTMLCanvasElement | null>(null)
  const tabCoreRef = useRef<HTMLCanvasElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const asideRef = useRef<HTMLElement | null>(null)
  const modeRef = useRef<CoreMode>('idle')

  useJarvisController()
  // J5 D3: the opt-in wake-word listener lives with the panel surface (same project
  // scope); it only ever OPENS the panel, and stands down whenever the panel is open.
  useWakeWord()

  const streaming = activeTurnId !== null
  const mode = deriveCoreMode({
    converse,
    speaking: ttsSpeaking,
    streaming: streaming && !awaiting,
    awaiting,
    capturing,
    acting:
      pendingConfirm !== null || acts.some((a) => a.phase === 'confirm' || a.phase === 'running')
  })
  // Ref write in an effect (not render — React 19 lint rule); the core renderer reads it
  // per animation frame, which always runs after the commit.
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // Restore config once: enabled flag + persona labels (no position — the panel docks).
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void window.api.jarvis.config
      .get()
      .then((cfg) => {
        if (!alive) return
        setShow(cfg.enabled)
        setToneMeta(cfg.tonePreset === 'custom' ? 'custom tone' : cfg.tonePreset.replace('-', ' '))
        setAnnouncePolicy(cfg.announcePolicy)
        useJarvisStore.getState().setPersonaName(cfg.name)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [enabled])

  // Live-apply pushes (Settings toggle / persona rename). Disabling while open closes
  // the panel through the full teardown — the mic never outlives the surface.
  useEffect(() => {
    if (!enabled) return
    return window.api.jarvis.config.onChanged((cfg) => {
      setShow(cfg.enabled)
      setToneMeta(cfg.tonePreset === 'custom' ? 'custom tone' : cfg.tonePreset.replace('-', ' '))
      setAnnouncePolicy(cfg.announcePolicy)
      if (!cfg.enabled && useJarvisStore.getState().panelOpen) closeJarvisPanel()
    })
  }, [enabled])

  // The header core renderer — runs ONLY while the panel is open (closed = zero rAF).
  useEffect(() => {
    if (!enabled || !show || !panelOpen || !coreRef.current) return
    return startNeuralCore(coreRef.current, () => modeRef.current, HEADER_CORE_PX)
  }, [enabled, show, panelOpen])

  // The edge tab's mini core: ONE static frame, repainted only when the tab (re)appears.
  // Converse is always torn down before the panel closes, so the closed state is 'idle'.
  useEffect(() => {
    if (!enabled || !show || panelOpen || !tabCoreRef.current) return
    paintNeuralCoreFrame(tabCoreRef.current, 'idle', TAB_CORE_PX)
  }, [enabled, show, panelOpen])

  // a11y (library-panel discipline): the aside stays mounted + slid off-screen when
  // closed, so reflect `inert` imperatively — open removes it, closed sets it.
  useEffect(() => {
    const el = asideRef.current
    if (!el) return
    if (panelOpen) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [panelOpen])

  // One shortcut toggles panel+mic (KICKOFF-PANEL §4). Capture phase — a focused
  // terminal swallows bubble-phase keys (the VoicePill precedent).
  useEffect(() => {
    if (!enabled || !show) return
    const onKey = (e: KeyboardEvent): void => {
      if (!matchesPanelHotkey(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) toggleJarvisPanel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled, show])

  // Esc — the mic-off gesture, SCOPED (ESC-1; was a window-wide capture grab that ate
  // Esc bound for vim/TUI in terminal boards, double-fired with the full-view capture
  // Esc and suppressed every bubble-phase Esc consumer). This listener owns only the
  // in-panel case: target INSIDE the panel → capture + stop (the full-view capture
  // listener has a matching bail for panel-contained targets). The canvas-root case
  // (<body> / RF pane — the quick mic kill when focus is nowhere more specific) lives
  // in useCanvasKeybindings' capture Esc chain, ordered confirm gate > palette >
  // full view > panel > clear-selection — the only registration-order-proof home for
  // it (a bubble listener here could not stop the same press from ALSO clearing the
  // board selection; PR #343 review).
  useEffect(() => {
    if (!panelOpen) return
    const onCaptureKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (!(e.target instanceof Element) || !asideRef.current?.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      closeJarvisPanel()
    }
    window.addEventListener('keydown', onCaptureKey, true)
    return () => window.removeEventListener('keydown', onCaptureKey, true)
  }, [panelOpen])

  // Keep the transcript pinned to the newest row while a reply streams / turns land.
  useEffect(() => {
    const el = bodyRef.current
    if (el && panelOpen) el.scrollTop = el.scrollHeight
  }, [panelOpen, turns.length, streamText, lastError, acts, pendingConfirm, composing])

  // D8 spoken announce (J4): a NEW attention mark may speak — grounded in the event
  // (board title + kind), per the persisted policy: 'all' speaks every event,
  // 'attention' only needs-input/error, 'chips-only' never speaks. Speaking is NOT
  // mic-gated (KICKOFF-PANEL §3): this runs with the panel closed too — the surface
  // (this component) is mounted whenever Jarvis is enabled. A missing TTS model just
  // rejects; the chip/badge remain the visual truth either way.
  const announcedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const seen = announcedRef.current
    for (const [boardId, kind] of Object.entries(attention)) {
      const key = `${boardId}:${kind}`
      if (seen.has(key)) continue
      seen.add(key)
      if (announcePolicy === 'chips-only') continue
      if (announcePolicy === 'attention' && kind === 'done') continue
      const title =
        useCanvasStore
          .getState()
          .boards.find((b) => b.id === boardId)
          ?.title?.trim() || 'An agent board'
      speakText(`${title}: ${ANNOUNCE_MSG[kind]}.`).catch(() => {})
    }
    // Cleared marks may re-announce later (a re-mark IS a new event).
    for (const key of [...seen]) {
      const [boardId, kind] = [
        key.slice(0, key.lastIndexOf(':')),
        key.slice(key.lastIndexOf(':') + 1)
      ]
      if (attention[boardId] !== kind) seen.delete(key)
    }
  }, [attention, announcePolicy])

  if (!enabled || !show) return null

  // MIC-3: the strip claims what the mic is DOING, not what the toggle asked for — an
  // OS-denied mic (permission 'denied', or the silent-zeros watchdog: a live stream the
  // OS feeds only zeros, electron#42714) must never read "mic live". The denial CTA the
  // dictation flyout shows is composer-suppressed in converse mode, so this strip is the
  // only surface left to say it.
  const micDenied = converse && (micStatus === 'denied' || micSilent)
  const micLabel = !converse
    ? 'mic off — click to arm'
    : micDenied
      ? 'mic blocked by the OS — check system microphone permissions'
      : !capturing
        ? 'mic arming…'
        : 'mic live — only while this panel is open'

  // BADGE-1: attention marks can outlive their board (delete / project switch) — a chip
  // for a dead id would focus nothing and the badge would count ghosts. Render only
  // marks whose board still exists; the stale store entries stay inert (bounded, and
  // cleared anyway the next time that id is marked or the store resets).
  const eventEntries = Object.entries(attention).filter(([boardId]) =>
    boards.some((b) => b.id === boardId)
  )
  const focusBoard = (boardId: string): void => {
    // The useNotifications focus intent: camera-fit + select (selecting clears the mark).
    useCanvasStore.setState({ pendingFocusId: boardId })
    useCanvasStore.getState().selectBoard(boardId)
  }

  const errorRow = (reason: string): ReactElement => (
    <div className="jp-error" role="alert" data-test="jarvis-error">
      {reason === 'no-key' ? (
        <>
          The brain isn&apos;t configured — set a provider and API key.{' '}
          <button
            className="jp-link"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('expanse:open-settings', { detail: { section: 'llm' } })
              )
            }
          >
            Open Settings › Context · LLM
          </button>
        </>
      ) : reason === 'budget-exceeded' ? (
        <>
          Daily LLM call budget reached.{' '}
          <button
            className="jp-link"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('expanse:open-settings', { detail: { section: 'llm' } })
              )
            }
          >
            Raise it in Settings › Context · LLM
          </button>
        </>
      ) : (
        <>The brain hit an error: {reason}</>
      )}
    </div>
  )

  return (
    <>
      {!panelOpen && (
        <button
          type="button"
          className="jarvis-edge-tab"
          data-test="jarvis-edge-tab"
          onClick={openJarvisPanel}
          title={`Talk to ${personaName} — opens the panel and arms the mic (${HOTKEY_LABEL})`}
          aria-label={`Open the ${personaName} panel and arm the microphone`}
        >
          <span className="jtab-mini">
            <canvas ref={tabCoreRef} />
            {eventEntries.length > 0 && (
              <span className="jtab-badge" data-test="jarvis-badge">
                {eventEntries.length}
              </span>
            )}
          </span>
          <span className="jtab-label">{personaName}</span>
        </button>
      )}
      <aside
        ref={asideRef}
        className="jarvis-panel"
        data-test="jarvis-panel"
        data-open={panelOpen}
        data-state={mode}
        aria-hidden={!panelOpen}
        aria-label={`${personaName} voice assistant`}
      >
        <div className="jp-hd">
          <span className="jp-core">
            <canvas ref={coreRef} />
          </span>
          <span className="jp-id">
            <span className="jp-name">{personaName}</span>
            <span className="jp-meta">
              {toneMeta} · {speechReady ? 'voice' : 'text-only'}
            </span>
          </span>
          <span
            className={`jp-state${mode === 'listening' || mode === 'speaking' ? '' : ' quiet'}`}
            data-test="jarvis-state"
          >
            <i />
            {mode}
          </span>
          <button
            className="jp-x"
            data-test="jarvis-close"
            onClick={closeJarvisPanel}
            aria-label="Close the panel and stop the microphone"
            title="Close — mic off (Esc)"
          >
            ✕
          </button>
        </div>

        {/* The mic-gate strip: THE standing contract, on screen exactly while the mic can
            hear. Also the in-panel arm control (a failed arm — no key — lands here off). */}
        <button
          className={`jp-mic${converse ? (micDenied ? ' denied' : '') : ' off'}`}
          data-test="jarvis-mic"
          data-mic={!converse ? 'off' : micDenied ? 'denied' : capturing ? 'live' : 'arming'}
          onClick={toggleConverse}
          aria-pressed={converse}
          title={converse ? 'Click to stop the microphone' : 'Click to arm the microphone'}
        >
          <i />
          {micLabel}
          <span className="key">{HOTKEY_LABEL}</span>
        </button>

        <div className="jp-body" ref={bodyRef} data-test="jarvis-body">
          {turns.length > HISTORY_WINDOW && (
            <span className="jp-hist-chip">
              earlier · {turns.length - HISTORY_WINDOW} turns beyond the model’s window
            </span>
          )}
          {turns.length === 0 && !streaming && !lastError && (
            <div className="jp-empty">
              {converse ? 'Listening — just talk.' : 'No turns yet this session.'}
            </div>
          )}
          {turns.map((t: JarvisDisplayTurn, i) => {
            const prev = turns[i - 1]
            const newDay = t.at > 0 && (!prev || dayLabel(prev.at) !== dayLabel(t.at))
            return (
              <div key={i}>
                {newDay && <div className="jp-sep">{dayLabel(t.at)}</div>}
                {t.role === 'user' ? (
                  <div className="jp-you">
                    <b>You</b> · {t.text}
                    {t.at > 0 && <span className="jp-t">{timeLabel(t.at)}</span>}
                  </div>
                ) : t.role === 'act' && t.act ? (
                  <ActChip act={t.act} />
                ) : (
                  <div className="jp-reply">
                    {t.text}
                    {t.interrupted && <span className="jp-interrupted"> — interrupted</span>}
                  </div>
                )}
              </div>
            )
          })}
          {streaming && (
            <div data-test="jarvis-streaming">
              <div className="jp-you">
                <b>You</b> · {lastUserText}
              </div>
              <div className="jp-reply">
                {streamText}
                <span className="jp-caret" />
              </div>
              {/* J4 turn-act rows (exhibit F): resolved acts collapse to chips; the act
                  awaiting its gate renders the pending card (✓/✗ + the voice answer). A
                  gated act whose routed request hasn't landed yet paints card-without-
                  buttons for the ~one-frame gap. */}
              {acts.map((a) =>
                a.phase === 'ok' || a.phase === 'denied' || a.phase === 'error' ? (
                  <ActChip key={a.actId} act={a} />
                ) : (
                  <div
                    key={a.actId}
                    className={`jp-act-card${a.phase === 'running' ? ' running' : ''}`}
                    data-test="jarvis-act-card"
                    data-phase={a.phase}
                  >
                    <span className="jp-ac-hd">
                      <i />
                      {a.name} · {a.phase === 'running' ? 'running' : 'needs your ok'}
                    </span>
                    <span className="jp-ac-body">
                      {a.phase === 'confirm' && pendingConfirm ? pendingConfirm.body : a.summary}
                    </span>
                    {a.phase === 'confirm' && pendingConfirm && (
                      <span className="jp-ac-btns">
                        <button
                          type="button"
                          className="jp-ac-yes"
                          data-test="jarvis-act-approve"
                          onClick={() => useJarvisStore.getState().answerPendingConfirm(true)}
                        >
                          ✓ do it
                        </button>
                        <button
                          type="button"
                          className="jp-ac-no"
                          data-test="jarvis-act-deny"
                          onClick={() => useJarvisStore.getState().answerPendingConfirm(false)}
                        >
                          ✗ cancel
                        </button>
                        <span className="jp-ac-voice">
                          or say <b>“yes”</b> / <b>“no”</b>
                        </span>
                      </span>
                    )}
                  </div>
                )
              )}
            </div>
          )}
          {/* Listen-hold composing row: buffered finals awaiting the send. Rendered
              whenever the buffer is non-empty (a manual-mode buffer must stay visible
              even while a superseding reply streams — it is unsent user text). */}
          {composing && (
            <div className="jp-composing" data-test="jarvis-composing">
              <div className="jp-you jp-partial">
                <b>You</b> · {composing}
              </div>
              <div className="jp-comp-bar">
                <span className="jp-comp-hint">
                  {listenMode === 'manual'
                    ? 'say “send it” or press Send'
                    : 'pausing sends — keep talking to add more'}
                </span>
                <button
                  type="button"
                  className="jp-comp-send"
                  data-test="jarvis-send"
                  onClick={sendComposingNow}
                  title="Send this to the brain now"
                >
                  Send ▸
                </button>
              </div>
            </div>
          )}
          {!streaming && mode === 'listening' && partial && (
            <div className="jp-you jp-partial">
              <b>You</b> · {partial}
            </div>
          )}
          {lastError && errorRow(lastError)}
        </div>

        {/* D8 relocation: agent-event chips dock at the panel foot; chip click focuses the
            board (which clears its unseen mark via the existing selection subscription). */}
        {eventEntries.length > 0 && (
          <div className="jp-events" data-test="jarvis-events">
            <span className="jp-events-lbl">agent events · {eventEntries.length} unread</span>
            {eventEntries.map(([boardId, kind]) => {
              const board = boards.find((b) => b.id === boardId)
              return (
                <button
                  key={boardId}
                  className="jp-notif"
                  onClick={() => focusBoard(boardId)}
                  title="Focus this board"
                >
                  <span className={`jp-nf-dot ${kind}`} />
                  <span className="jp-nf-main">
                    <span className="jp-nf-board">{board?.title?.trim() || 'Agent board'}</span>
                    <span className="jp-nf-msg">{EVENT_MSG[kind]}</span>
                  </span>
                  <span className="jp-nf-focus">focus ↵</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="jp-ft">
          <span>
            <b>speak</b> to interrupt
          </span>
          <span>
            <b>esc</b> closes · mic off
          </span>
          <span className="end">grounded in tool results</span>
        </div>
      </aside>
    </>
  )
}

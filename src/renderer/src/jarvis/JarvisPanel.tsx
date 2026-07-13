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
import { useJarvisStore, type JarvisDisplayTurn } from '../store/jarvisStore'
import { useTtsStore } from '../store/ttsStore'
import { useVoiceStore } from '../store/voiceStore'
import { useAttentionStore, type AttentionKind } from '../store/attentionStore'
import { useCanvasStore } from '../store/canvasStore'
import { startNeuralCore, paintNeuralCoreFrame, type CoreMode } from './neuralCore'
import {
  closeJarvisPanel,
  openJarvisPanel,
  toggleConverse,
  toggleJarvisPanel,
  useJarvisController
} from './jarvisSession'

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
}): CoreMode {
  if (!s.converse) return 'idle'
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
  const lastError = useJarvisStore((s) => s.lastError)
  const personaName = useJarvisStore((s) => s.personaName)
  const speechReady = useJarvisStore((s) => s.speechReady)
  const ttsSpeaking = useTtsStore((s) => s.speaking)
  const capturing = useVoiceStore((s) => s.capturing)
  const partial = useVoiceStore((s) => s.partial)
  const attention = useAttentionStore((s) => s.byId)
  // Subscribed (not getState) so a board retitle re-renders the D8 chips (NIT-2).
  const boards = useCanvasStore((s) => s.boards)

  const [show, setShow] = useState(true)
  const [toneMeta, setToneMeta] = useState('butler')
  const coreRef = useRef<HTMLCanvasElement | null>(null)
  const tabCoreRef = useRef<HTMLCanvasElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const asideRef = useRef<HTMLElement | null>(null)
  const modeRef = useRef<CoreMode>('idle')

  useJarvisController()

  const streaming = activeTurnId !== null
  const mode = deriveCoreMode({
    converse,
    speaking: ttsSpeaking,
    streaming: streaming && !awaiting,
    awaiting,
    capturing
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
  // Esc and suppressed every bubble-phase Esc consumer). Two tiers, one Esc one layer:
  //  · target INSIDE the panel (capture + stop) — the panel owns that Esc outright; the
  //    full-view capture listener has a matching bail for panel-contained targets.
  //  · target = <body> (bubble) — focus is nowhere more specific, so Esc keeps working
  //    as the quick mic kill. Bubble phase means a focused terminal/editor/full-view
  //    (which consume in capture or hold their own focus target) never loses its Esc;
  //    the palette/confirm-gate guards keep deeper layers first.
  useEffect(() => {
    if (!panelOpen) return
    const onCaptureKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (!(e.target instanceof Element) || !asideRef.current?.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      closeJarvisPanel()
    }
    const onBubbleKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Canvas root only: <body> or the focusable React Flow pane. Anything more
      // specific (terminal, editor, flyout, modal) owns its own Esc.
      const t = e.target
      const onCanvasRoot =
        t === document.body || (t instanceof Element && t.classList.contains('react-flow__pane'))
      if (!onCanvasRoot) return
      if (document.querySelector('[data-confirm-active]')) return
      if (document.querySelector('[data-palette-open]')) return
      e.preventDefault()
      closeJarvisPanel()
    }
    window.addEventListener('keydown', onCaptureKey, true)
    window.addEventListener('keydown', onBubbleKey)
    return () => {
      window.removeEventListener('keydown', onCaptureKey, true)
      window.removeEventListener('keydown', onBubbleKey)
    }
  }, [panelOpen])

  // Keep the transcript pinned to the newest row while a reply streams / turns land.
  useEffect(() => {
    const el = bodyRef.current
    if (el && panelOpen) el.scrollTop = el.scrollHeight
  }, [panelOpen, turns.length, streamText, lastError])

  if (!enabled || !show) return null

  const eventEntries = Object.entries(attention)
  const focusBoard = (boardId: string): void => {
    // The useNotifications focus intent: camera-fit + select (selecting clears the mark).
    useCanvasStore.setState({ pendingFocusId: boardId })
    useCanvasStore.getState().selectBoard(boardId)
  }

  const errorRow = (reason: string): ReactElement => (
    <div className="jp-error" role="alert" data-test="jarvis-error">
      {reason === 'no-key' ? (
        <>
          No API key set.{' '}
          <button
            className="jp-link"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('expanse:open-settings', { detail: { section: 'persona' } })
              )
            }
          >
            Open Settings › Persona
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
          className={`jp-mic${converse ? '' : ' off'}`}
          data-test="jarvis-mic"
          onClick={toggleConverse}
          aria-pressed={converse}
          title={converse ? 'Click to stop the microphone' : 'Click to arm the microphone'}
        >
          <i />
          {converse ? 'mic live — only while this panel is open' : 'mic off — click to arm'}
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
          <span className="end">
            <b>esc</b> closes · mic off
          </span>
        </div>
      </aside>
    </>
  )
}

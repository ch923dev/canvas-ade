/**
 * Jarvis J3 — the transcript tail + conversation view (mock exhibits D2 and E — the D4′
 * Exhibit F expansion, user-approved 2026-07-13). Collapsed: last utterance + streaming
 * reply while the turn runs. Expanded: the scrollable session transcript with day
 * separators. Esc collapses the view first, then dismisses the tail; converse stays on.
 */
import { useEffect, useMemo, type ReactElement } from 'react'
import { useJarvisStore, type JarvisDisplayTurn } from '../store/jarvisStore'
import { useVoiceStore } from '../store/voiceStore'
import type { CoreMode } from './neuralCore'
import type { IslandPos } from './JarvisIsland'

const TAIL_W = 400

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

export function JarvisTail({
  anchor,
  toneMeta,
  mode
}: {
  anchor: IslandPos
  toneMeta: string
  mode: CoreMode
}): ReactElement | null {
  const converse = useJarvisStore((s) => s.converseMode)
  const tailOpen = useJarvisStore((s) => s.tailOpen)
  const viewOpen = useJarvisStore((s) => s.viewOpen)
  const streamText = useJarvisStore((s) => s.streamText)
  const lastUserText = useJarvisStore((s) => s.lastUserText)
  const activeTurnId = useJarvisStore((s) => s.activeTurnId)
  const turns = useJarvisStore((s) => s.turns)
  const lastError = useJarvisStore((s) => s.lastError)
  const personaName = useJarvisStore((s) => s.personaName)
  const speechReady = useJarvisStore((s) => s.speechReady)
  const partial = useVoiceStore((s) => s.partial)

  const visible =
    converse && tailOpen && (activeTurnId !== null || turns.length > 0 || lastError !== null)

  // Esc: collapse the view first, then the tail (capture phase — a focused terminal
  // swallows bubble-phase keys; the VoicePill hotkey precedent).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const s = useJarvisStore.getState()
      if (s.viewOpen) s.setViewOpen(false)
      else s.setTailOpen(false)
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])

  // The collapsed tail's rows: the in-flight turn, else the last completed exchange.
  const lastAssistant = useMemo(
    () => [...turns].reverse().find((t) => t.role === 'assistant'),
    [turns]
  )
  const lastUser = useMemo(() => [...turns].reverse().find((t) => t.role === 'user'), [turns])
  const youText =
    activeTurnId !== null
      ? lastUserText
      : mode === 'listening' && partial
        ? partial
        : (lastUser?.text ?? lastUserText)
  const replyText = activeTurnId !== null ? streamText : (lastAssistant?.text ?? '')
  const streaming = activeTurnId !== null

  if (!visible) return null

  const left = Math.max(8, Math.min(anchor.x + 168 - TAIL_W, window.innerWidth - TAIL_W - 8))
  const top = anchor.y + 34 + 8

  const errorRow = (reason: string): ReactElement => (
    <div className="jt-error" role="alert" data-test="jarvis-error">
      {reason === 'no-key' ? (
        <>
          No API key set.{' '}
          <button
            className="jt-link"
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
    <div className="jarvis-tail" style={{ left, top, width: TAIL_W }} data-test="jarvis-tail">
      <div className="jt-hd">
        <span className="jt-name">{personaName}</span>
        <span className="jt-meta">
          {toneMeta} · {speechReady ? 'voice' : 'text-only'}
        </span>
        <span className={`jt-live${streaming || mode === 'speaking' ? ' on' : ''}`}>
          <i />
          {mode}
        </span>
        <button
          className="jt-expand"
          title={viewOpen ? 'Collapse to tail' : 'Show conversation'}
          aria-label={viewOpen ? 'Collapse conversation view' : 'Expand conversation view'}
          data-test="jarvis-expand"
          onClick={() => useJarvisStore.getState().setViewOpen(!viewOpen)}
        >
          {viewOpen ? '⌄' : '⌃'}
        </button>
      </div>

      {!viewOpen ? (
        <div className="jt-body" data-test="jarvis-tail-body">
          {lastError && errorRow(lastError)}
          {youText && (
            <div className="jt-you">
              <b>You</b> · {youText}
            </div>
          )}
          {(replyText || streaming) && (
            <div className="jt-reply" data-test="jarvis-reply">
              {replyText}
              {streaming && <span className="jt-caret" />}
              {!streaming && lastAssistant?.interrupted && (
                <span className="jt-interrupted"> — interrupted</span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="jt-hist" data-test="jarvis-history">
          {lastError && errorRow(lastError)}
          {turns.length === 0 && !streaming && (
            <div className="jt-empty">No turns yet this session.</div>
          )}
          {turns.map((t: JarvisDisplayTurn, i) => {
            const prev = turns[i - 1]
            const newDay = t.at > 0 && (!prev || dayLabel(prev.at) !== dayLabel(t.at))
            return (
              <div key={i}>
                {newDay && <div className="jt-sep">{dayLabel(t.at)}</div>}
                {t.role === 'user' ? (
                  <div className="jt-turn-you">
                    <b>You</b> · {t.text}
                    {t.at > 0 && <span className="jt-t">{timeLabel(t.at)}</span>}
                  </div>
                ) : (
                  <div className="jt-turn-j">
                    {t.text}
                    {t.interrupted && <span className="jt-interrupted"> — interrupted</span>}
                  </div>
                )}
              </div>
            )
          })}
          {streaming && (
            <div>
              <div className="jt-turn-you">
                <b>You</b> · {lastUserText}
              </div>
              <div className="jt-turn-j">
                {streamText}
                <span className="jt-caret" />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="jt-ft">
        <span>
          <b>speak</b> to interrupt
        </span>
        <span>
          <b>esc</b> dismiss
        </span>
        <span className="jt-ft-end">
          {viewOpen ? 'history · this session' : `grounded in the canvas`}
        </span>
      </div>
    </div>
  )
}

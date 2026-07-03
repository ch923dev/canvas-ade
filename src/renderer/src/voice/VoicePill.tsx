/**
 * Voice V3 — the floating VoicePill (SPEC §3, pill mock v2 approved as-is). A screen-fixed
 * draggable overlay island (like toast/minimap — NOT inside React Flow): grip dots + app
 * logo + live RMS waveform bars. Click or Ctrl/Cmd+Shift+M toggles listening; press-and-
 * hold the hotkey is push-to-talk (release stops). Dragging never toggles (a small
 * movement threshold decides click vs drag); the position is viewport-clamped and persists
 * app-level via `voiceConfig.pillPosition` (debounced). This component also owns the
 * session babysitters: the silence auto-STOP (~15 s, never submits) + the ~2 min hard cap,
 * and the mic-denied attention hoist. The VoiceFlyout mounts here, anchored to the pill.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import logoUrl from '../../../../build/icon.png'
import { useVoiceStore } from '../store/voiceStore'
import { startVoice, stopVoice, toggleVoice } from './voiceSession'
import { VoiceFlyout } from './VoiceFlyout'

/** Nominal pill box for clamping (measured look; exact width varies a few px with DPI). */
export const PILL_W = 150
export const PILL_H = 34
const MARGIN = 8
/** Pointer travel (px) below which a pointerup is a click (toggle), not a drag. */
export const DRAG_THRESHOLD = 4
/** Hotkey held longer than this = push-to-talk (release stops); shorter = toggle tap. */
const HOLD_MS = 500
/** Silence auto-STOP (~15 s) + hard session cap (~2 min). Stop, never submit (SPEC §3). */
const SILENCE_STOP_MS = 15_000
const MAX_SESSION_MS = 120_000
/** Drag-position persist debounce. */
const PERSIST_MS = 400

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

export interface PillPos {
  x: number
  y: number
}

/** Clamp a pill position fully inside the viewport (also applied to restored config). */
export function clampPillPos(pos: PillPos, vw: number, vh: number): PillPos {
  return {
    x: Math.min(Math.max(pos.x, MARGIN), Math.max(MARGIN, vw - PILL_W - MARGIN)),
    y: Math.min(Math.max(pos.y, MARGIN), Math.max(MARGIN, vh - PILL_H - MARGIN))
  }
}

export function defaultPillPos(vw: number, vh: number): PillPos {
  return clampPillPos({ x: Math.round((vw - PILL_W) / 2), y: vh - PILL_H - 24 }, vw, vh)
}

/** Ctrl/Cmd+Shift+M — `code` so the binding survives keyboard layouts. */
function isVoiceHotkey(e: KeyboardEvent): boolean {
  return e.code === 'KeyM' && e.shiftKey && !e.altKey && (IS_MAC ? e.metaKey : e.ctrlKey)
}

/** Per-bar level multipliers (mock v2's uneven waveform silhouette). */
const BAR_SHAPE = [0.45, 0.8, 1, 0.6, 0.9, 0.4, 0.7]

export function VoicePill(): ReactElement | null {
  const enabled = !!window.api?.voice // non-electron test runtimes render nothing
  const capturing = useVoiceStore((s) => s.capturing)
  const level = useVoiceStore((s) => s.level)
  const micSilent = useVoiceStore((s) => s.micSilent)
  const micStatus = useVoiceStore((s) => s.micStatus)
  const [pos, setPos] = useState<PillPos | null>(null)
  const [showPill, setShowPill] = useState(true)
  // Drag bookkeeping lives in refs — the pointer handlers are stable across renders.
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: PillPos
    dragging: boolean
  } | null>(null)
  const persistTimer = useRef<number | null>(null)
  // PTT bookkeeping (hotkey keydown → keyup pairing).
  const downAtRef = useRef<number | null>(null)
  const wasIdleRef = useRef(false)

  // Restore config once: position (re-clamped — displays change between runs) + show flag.
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void window.api.voice.config
      .get()
      .then((cfg) => {
        if (!alive) return
        setShowPill(cfg.showPill)
        const restored = cfg.pillPosition ?? defaultPillPos(window.innerWidth, window.innerHeight)
        setPos(clampPillPos(restored, window.innerWidth, window.innerHeight))
      })
      .catch(() => {
        if (alive) setPos(defaultPillPos(window.innerWidth, window.innerHeight))
      })
    return () => {
      alive = false
    }
  }, [enabled])

  // Keep the pill on-screen across window resizes.
  useEffect(() => {
    const onResize = (): void =>
      setPos((p) => (p ? clampPillPos(p, window.innerWidth, window.innerHeight) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Hotkey — CAPTURE phase: a focused terminal stopPropagation()s bubble-phase keydown
  // (useTerminalSpawn stopKeys), and the primary dictation flow is exactly "terminal
  // focused, hands on keyboard". Registered once; handlers read refs/store directly
  // (mid-dispatch listener-removal discipline). Quick press = toggle; hold = push-to-talk.
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isVoiceHotkey(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat || downAtRef.current !== null) return
      downAtRef.current = Date.now()
      wasIdleRef.current = !useVoiceStore.getState().capturing
      if (wasIdleRef.current) void startVoice()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      // Match on code alone: the modifiers may already be released by the M keyup.
      if (e.code !== 'KeyM' || downAtRef.current === null) return
      const held = Date.now() - downAtRef.current
      downAtRef.current = null
      // Quick press from idle = toggle ON (stay listening). Everything else — a hold
      // release (PTT) or a quick press while already listening — stops.
      if (wasIdleRef.current && held < HOLD_MS) return
      void stopVoice()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [enabled])

  // Session babysitter: silence auto-STOP + hard cap. Stop only — never a submit path.
  useEffect(() => {
    if (!capturing) return
    const iv = window.setInterval(() => {
      const s = useVoiceStore.getState()
      if (!s.capturing) return
      const now = Date.now()
      if (now - s.captureStartedAt > MAX_SESSION_MS) void stopVoice()
      else if (s.lastVoiceAt > 0 && now - s.lastVoiceAt > SILENCE_STOP_MS) void stopVoice()
    }, 1000)
    return () => window.clearInterval(iv)
  }, [capturing])

  // Attention hoist: an all-zeros stream while "listening" is the OS-denied-without-error
  // case (electron#42714) — surface the mic-denied flyout row the moment the watchdog trips.
  useEffect(() => {
    if (micSilent) useVoiceStore.getState().setFlyoutOpen(true)
  }, [micSilent])

  const persistPos = (p: PillPos): void => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null
      void window.api.voice.config.set({ pillPosition: p }).catch(() => {})
    }, PERSIST_MS)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !pos) return
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: pos,
      dragging: false
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* jsdom (unit tests) has no pointer capture; move/up still bubble to the pill */
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    d.dragging = true
    const next = clampPillPos(
      { x: d.origin.x + dx, y: d.origin.y + dy },
      window.innerWidth,
      window.innerHeight
    )
    setPos(next)
    persistPos(next)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (!d.dragging) toggleVoice() // a clean click — drag never toggles
  }

  if (!enabled || !pos) return null

  const denied = micSilent || micStatus === 'denied'
  const liveLevel = Math.min(1, level * 6) // speech RMS ~0.02–0.2 → usable bar range

  return (
    <>
      {showPill && (
        <div
          className={`voice-pill${capturing ? ' listening' : ''}${denied ? ' denied' : ''}`}
          style={{ left: pos.x, top: pos.y }}
          role="button"
          aria-pressed={capturing}
          aria-label="Voice dictation"
          data-test="voice-pill"
          title={
            capturing
              ? 'Drag to reposition · click to stop'
              : `Click or ${IS_MAC ? 'Cmd' : 'Ctrl'}+Shift+M to dictate · drag to move`
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <span className="vp-grip">
            <i />
            <i />
            <i />
          </span>
          <img className="vp-logo" src={logoUrl} alt="" draggable={false} />
          {denied && <span className="vp-sdot" />}
          <span className={`vp-bars${capturing ? ' live' : ''}`} data-test="voice-pill-bars">
            {BAR_SHAPE.map((m, i) => (
              // Constant 16px layout box; the level drives scaleY (0.25 = the idle 4px look).
              <i
                key={i}
                style={{
                  transform: `scaleY(${capturing ? Math.min(1, 0.25 + liveLevel * m * 0.75) : 0.25})`
                }}
              />
            ))}
          </span>
        </div>
      )}
      <VoiceFlyout anchor={pos} />
    </>
  )
}

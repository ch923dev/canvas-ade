/**
 * Jarvis J3 — the persona island (mock rev 2, exhibits A/B1–B4/D2, user-approved
 * 2026-07-10; Exhibit F approved 2026-07-13). A screen-fixed draggable overlay island in
 * the VoicePill family: grip + canvas neural core + per-state trim (RMS bars / think
 * dots) + state label, docked top-right by default. Click toggles converse mode; the
 * transcript tail (JarvisTail) anchors under it. z-index 120 tier — deliberately below
 * the full-view scrim (200), like the VoicePill.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useJarvisStore } from '../store/jarvisStore'
import { useTtsStore } from '../store/ttsStore'
import { useVoiceStore } from '../store/voiceStore'
import { startNeuralCore, type CoreMode } from './neuralCore'
import { toggleConverse, useJarvisController } from './jarvisSession'
import { JarvisTail } from './JarvisTail'

/** Nominal island box for clamping (VoicePill discipline). */
export const JARVIS_W = 168
export const JARVIS_H = 34
const MARGIN = 12
const DRAG_THRESHOLD = 4
const PERSIST_MS = 400

export interface IslandPos {
  x: number
  y: number
}

export function clampIslandPos(pos: IslandPos, vw: number, vh: number): IslandPos {
  return {
    x: Math.min(Math.max(pos.x, MARGIN), Math.max(MARGIN, vw - JARVIS_W - MARGIN)),
    y: Math.min(Math.max(pos.y, MARGIN), Math.max(MARGIN, vh - JARVIS_H - MARGIN))
  }
}

/** D7: docked top-right by default (left edge = panels/file tree, bottom = toast/minimap). */
export function defaultIslandPos(vw: number, vh: number): IslandPos {
  return clampIslandPos({ x: vw - JARVIS_W - MARGIN, y: MARGIN }, vw, vh)
}

/** Per-bar level multipliers (the mock's uneven 5-bar cap silhouette). */
const BAR_SHAPE = [0.6, 0.9, 1, 0.7, 0.85]

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

export function JarvisIsland(): ReactElement | null {
  const enabled = !!window.api?.jarvis && window.api.voice?.supported !== false
  const converse = useJarvisStore((s) => s.converseMode)
  const awaiting = useJarvisStore((s) => s.awaitingReply)
  const activeTurnId = useJarvisStore((s) => s.activeTurnId)
  const lastError = useJarvisStore((s) => s.lastError)
  const personaName = useJarvisStore((s) => s.personaName)
  const ttsSpeaking = useTtsStore((s) => s.speaking)
  const capturing = useVoiceStore((s) => s.capturing)
  const level = useVoiceStore((s) => s.level)

  const [pos, setPos] = useState<IslandPos | null>(null)
  const [show, setShow] = useState(true)
  const [toneMeta, setToneMeta] = useState('butler')
  const coreRef = useRef<HTMLCanvasElement | null>(null)
  const modeRef = useRef<CoreMode>('idle')
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: IslandPos
    dragging: boolean
  } | null>(null)
  const persistTimer = useRef<number | null>(null)

  useJarvisController()

  const mode = deriveCoreMode({
    converse,
    speaking: ttsSpeaking,
    streaming: activeTurnId !== null && !awaiting,
    awaiting,
    capturing
  })
  // Ref write in an effect (not render — React 19 lint rule); the core renderer reads it
  // per animation frame, which always runs after the commit.
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // Restore config once: position (re-clamped), enabled flag, persona labels.
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
        const restored =
          cfg.islandPosition ?? defaultIslandPos(window.innerWidth, window.innerHeight)
        setPos(clampIslandPos(restored, window.innerWidth, window.innerHeight))
      })
      .catch(() => {
        if (alive) setPos(defaultIslandPos(window.innerWidth, window.innerHeight))
      })
    return () => {
      alive = false
    }
  }, [enabled])

  // Live-apply pushes (Settings toggle / persona rename), position excluded (drag owns it).
  useEffect(() => {
    if (!enabled) return
    return window.api.jarvis.config.onChanged((cfg) => {
      setShow(cfg.enabled)
      setToneMeta(cfg.tonePreset === 'custom' ? 'custom tone' : cfg.tonePreset.replace('-', ' '))
    })
  }, [enabled])

  useEffect(() => {
    const onResize = (): void =>
      setPos((p) => (p ? clampIslandPos(p, window.innerWidth, window.innerHeight) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The neural core renderer — reads the mode per frame via ref (no restart on flips).
  useEffect(() => {
    if (!enabled || !show || !pos || !coreRef.current) return
    return startNeuralCore(coreRef.current, () => modeRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only on mount/show
  }, [enabled, show, pos === null])

  const persistPos = (p: IslandPos): void => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null
      void window.api.jarvis.config.set({ islandPosition: p }).catch(() => {})
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
      /* jsdom has no pointer capture */
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    d.dragging = true
    const next = clampIslandPos(
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
    if (!d.dragging) toggleConverse()
  }

  if (!enabled || !show || !pos) return null

  const liveLevel = Math.min(1, level * 6)
  const noKey = lastError === 'no-key'

  return (
    <>
      <div
        className={`jarvis-island ji-${mode}`}
        style={{ left: pos.x, top: pos.y }}
        role="button"
        aria-pressed={converse}
        aria-label={`${personaName} voice assistant`}
        data-test="jarvis-island"
        data-state={mode}
        title={
          converse
            ? `${personaName} is on — click to end the conversation · drag to move`
            : `Talk to ${personaName} — click to start · drag to move`
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="ji-grip">
          <i />
          <i />
          <i />
        </span>
        <span className="ji-core">
          <canvas ref={coreRef} />
        </span>
        {noKey && (
          <span className="ji-err-dot" title="No API key — set one in Settings › Voice › Persona" />
        )}
        {mode === 'thinking' ? (
          <span className="ji-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className={`ji-cap${mode === 'speaking' ? ' speak' : ''}`} aria-hidden>
            {BAR_SHAPE.map((m, i) => (
              <i
                key={i}
                style={
                  mode === 'listening'
                    ? { transform: `scaleY(${Math.min(1, 0.25 + liveLevel * m * 0.75)})` }
                    : undefined
                }
              />
            ))}
          </span>
        )}
        <span className="ji-state" data-test="jarvis-state">
          {mode}
        </span>
      </div>
      <JarvisTail anchor={pos} toneMeta={toneMeta} mode={mode} />
    </>
  )
}

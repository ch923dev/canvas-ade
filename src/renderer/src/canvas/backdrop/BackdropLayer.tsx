/**
 * Canvas backdrop — the screen-fixed wallpaper layer behind React Flow
 * (docs/canvas-backdrop/spec.md §4). Desktop-wallpaper semantics: fills the canvas
 * pane, does NOT pan/zoom with the camera.
 *
 * INVARIANTS (spec §4 — do not violate):
 * - Never reads the viewport, never re-renders on pan/zoom (no camera subscription
 *   of any kind — re-renders happen only on `background` settings changes).
 * - `pointer-events: none` and strictly BENEATH React Flow: never participates in
 *   chromeExclusionZones / preview-occlusion math (ADR 0002 untouched).
 * - Media bytes only via the frame-guarded asset IPC (useBackdropMedia).
 *
 * Failure surfaces (never silent):
 * - Missing wallpaper file (deleted / project cloned without assets/): revert the
 *   stored kind to 'none' + keyed toast (spec §3).
 * - Unknown scene id (a newer build's preset opened here): the SETTING is preserved
 *   (forward-compat — boardSchema keeps the id verbatim), this layer renders plain
 *   void + a keyed toast. PR 2 mounts the actual scene <canvas> host (S6/S7).
 */
import { useEffect, useRef, type ReactElement } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { showToast } from '../../store/toastStore'
import { useBackdropMedia } from './useBackdropMedia'
import { getScene } from './sceneRegistry'

export const BACKDROP_MISSING_TOAST_ID = 'backdrop-missing'
export const BACKDROP_UNKNOWN_SCENE_TOAST_ID = 'backdrop-scene-unknown'

export function BackdropLayer(): ReactElement | null {
  const background = useCanvasStore((s) => s.background)
  const setBackground = useCanvasStore((s) => s.setBackground)
  const active = background !== null && background.kind !== 'none'

  const media = useBackdropMedia(
    active && background.kind === 'file' ? background.assetId : undefined
  )

  // Missing wallpaper → revert to none + toast (spec §3). Keyed: a repeat replaces
  // in place instead of stacking. The revert rides the normal debounced autosave.
  useEffect(() => {
    if (media.status !== 'missing') return
    showToast({
      id: BACKDROP_MISSING_TOAST_ID,
      kind: 'error',
      message: 'Backdrop file missing — reverted to none'
    })
    setBackground({ kind: 'none' })
  }, [media.status, setBackground])

  // Unknown scene id → plain void + toast, setting preserved (forward-compat).
  const sceneId = active && background.kind === 'scene' ? background.scene : undefined
  const sceneKnown = sceneId !== undefined && getScene(sceneId) !== undefined
  useEffect(() => {
    if (!sceneId || sceneKnown) return
    showToast({
      id: BACKDROP_UNKNOWN_SCENE_TOAST_ID,
      message: 'Backdrop scene is not available in this version'
    })
  }, [sceneId, sceneKnown])

  // Animation policy (spec §2): the wallpaper video pauses on document.hidden and
  // freezes (paused first frame = the still) under prefers-reduced-motion, live via
  // the matchMedia change listener. Listeners exist only while a ready video is
  // mounted (early exit below) — image/scene/none renders register nothing. Not the
  // mid-dispatch-removal class (no React-commit-driven event here).
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (media.status !== 'ready' || !media.video) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => {
      const v = videoRef.current
      if (!v) return
      if (document.hidden || mq.matches) v.pause()
      // Optional-chained: jsdom's play() returns undefined; a real autoplay
      // rejection just leaves the paused first frame standing (= the still).
      else void v.play()?.catch(() => undefined)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    mq.addEventListener('change', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      mq.removeEventListener('change', sync)
    }
  }, [media])

  if (!active) return null
  const filter = `saturate(${background.saturation})`
  return (
    <div className="backdrop-layer" aria-hidden="true" data-test="backdrop-layer">
      {background.kind === 'file' &&
        media.status === 'ready' &&
        (media.video ? (
          <video
            ref={videoRef}
            className="backdrop-media"
            src={media.url}
            style={{ filter }}
            muted
            loop
            playsInline
            autoPlay
          />
        ) : (
          <img className="backdrop-media" src={media.url} alt="" style={{ filter }} />
        ))}
      {/* kind 'scene': the <canvas> host + SceneHandle lifecycle land in PR 2 (S6/S7);
          until then a scene background shows tinted void (toast above when unknown). */}
      <div className="backdrop-dim" style={{ opacity: background.dim }} />
    </div>
  )
}

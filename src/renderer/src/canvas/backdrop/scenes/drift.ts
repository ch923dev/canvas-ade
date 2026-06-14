/**
 * Drift — the calmer of the two ambient scenes (PR 3a, S9). A faithful port of the
 * approved ambient mock `docs/canvas-backdrop/mocks/ambient-bg.html` (the DRIFT panel)
 * at its user-tuned numbers (period 18s, wavelength 520, brightness 0.07): the canvas's
 * own 24px dot lattice with a slow traveling cross-swell of luminance washing over it.
 *
 * Stateless per frame — every frame is a pure function of absolute time `t`, so a
 * pause/resume just jumps phase (no accumulated state to corrupt) and a reduced-motion
 * still is simply the unanimated grid (wv = 0, byte-identical to today's flat dots).
 *
 * Perf contract (docs/canvas-backdrop/addendum-presets.md §3): one canvas, buffer dpr
 * clamped to 1.5, <=30fps via a 33ms frame gate, full rAF stop on stop() (the layer
 * calls it on unmount / document.hidden), start() a no-op under reduced motion. jsdom-
 * safe: a null 2D context or zero clientWidth falls back to a 1920x1080 buffer and never
 * throws.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const FRAME_MS = 33 // <=30fps gate
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const GRID_GAP = 24 // CSS px between dots (the shipped lattice spacing)

/* ---------- tuned numbers (mock-identical) ---------- */
const BRIGHTNESS = 0.07 // wave luminance lift
const PERIOD = 18 // wave period, s
const WAVELENGTH = 520 // wave wavelength, CSS px
const A1 = 0.42 // two wave headings (rad) for an organic cross-swell
const A2 = 2.1

/** Paint one frame of the dot grid at absolute time `t` (seconds); `t = null` ⇒ the
 *  unanimated still (plain grid). Mirrors the mock's drawDrift / reduced branch. */
function drawDrift(
  x: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  t: number | null
): void {
  const gap = GRID_GAP * dpr
  x.fillStyle = 'rgb(10,10,11)' // --void
  x.fillRect(0, 0, w, h)
  const k1 = (2 * Math.PI) / (WAVELENGTH * dpr)
  const k2 = (2 * Math.PI) / (WAVELENGTH * 1.7 * dpr)
  const ph1 = t === null ? 0 : ((2 * Math.PI) / PERIOD) * t
  const ph2 = t === null ? 0 : ((2 * Math.PI) / (PERIOD * 1.6)) * t
  const lift = BRIGHTNESS * 190 // peak added luminance ~ +13 at default 0.07
  const r = Math.max(1, Math.round(0.5 * dpr)) * 2 // ~1px dot at dpr 1
  for (let y = gap / 2; y < h; y += gap) {
    for (let px = gap / 2; px < w; px += gap) {
      const wv =
        t === null
          ? 0
          : 0.5 +
            0.25 * Math.sin(k1 * (px * Math.cos(A1) + y * Math.sin(A1)) - ph1) +
            0.25 * Math.sin(k2 * (px * Math.cos(A2) + y * Math.sin(A2)) - ph2)
      const l = (wv * lift) | 0
      x.fillStyle = `rgb(${32 + l},${32 + l},${34 + l})`
      x.fillRect(px - r / 2, y - r / 2, r, r)
    }
  }
}

/* ---------- thumbnail (gallery picker) ---------- */
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<rect width="96" height="54" fill="#0a0a0b"/>' +
      '<defs><radialGradient id="g" cx="38%" cy="42%" r="70%">' +
      '<stop offset="0" stop-color="#46464b"/><stop offset="1" stop-color="#202022"/>' +
      '</radialGradient></defs>' +
      Array.from({ length: 6 * 11 }, (_, i) => {
        const col = i % 11
        const row = (i / 11) | 0
        return `<circle cx="${5 + col * 8.6}" cy="${6 + row * 8.5}" r="1.1" fill="url(#g)"/>`
      }).join('') +
      '</svg>'
  )

export const drift: SceneDef = {
  id: 'drift',
  label: 'Drift',
  tier: 'ambient',
  thumb: THUMB,
  create(canvas: HTMLCanvasElement, opts: SceneOpts): SceneHandle {
    const ctx = canvas.getContext('2d')
    let running = false
    let raf = 0
    let lastDraw = 0
    let sized = false
    let ro: ResizeObserver | null = null

    /** Match the buffer to the element (dpr clamped). Stateless scene ⇒ no model. */
    const ensureSize = (): boolean => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CLAMP)
      const w = canvas.clientWidth > 0 ? Math.round(canvas.clientWidth * dpr) : FALLBACK_W
      const h = canvas.clientHeight > 0 ? Math.round(canvas.clientHeight * dpr) : FALLBACK_H
      if (sized && w === canvas.width && h === canvas.height) return false
      canvas.width = w
      canvas.height = h
      sized = true
      return true
    }

    const paint = (t: number | null): void => {
      if (ctx === null) return
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CLAMP)
      drawDrift(ctx, canvas.width, canvas.height, dpr, t)
    }

    const observe = (): void => {
      if (ro !== null || typeof ResizeObserver === 'undefined') return
      ro = new ResizeObserver(() => {
        // The live loop repaints itself next frame; a parked still must repaint here
        // or it would stay stretched at the old buffer size.
        if (ensureSize() && !running) paint(null)
      })
      ro.observe(canvas)
    }

    const tick = (now: number): void => {
      if (!running) return
      if (lastDraw === 0 || now - lastDraw >= FRAME_MS) {
        lastDraw = now
        ensureSize()
        paint(now / 1000)
      }
      raf = requestAnimationFrame(tick)
    }

    return {
      start(): void {
        if (running || opts.reducedMotion) return
        running = true
        lastDraw = 0
        ensureSize()
        observe()
        raf = requestAnimationFrame(tick)
      },
      stop(): void {
        running = false
        if (raf !== 0) cancelAnimationFrame(raf)
        raf = 0
        ro?.disconnect()
        ro = null
      },
      renderStill(): void {
        ensureSize()
        observe()
        paint(null) // the reduced-motion still = the unanimated grid
      }
    }
  }
}

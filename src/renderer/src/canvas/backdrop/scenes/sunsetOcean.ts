/**
 * Sunset Ocean -- a bundled backdrop scene (scenic tier). A faithful port of
 * the approved mock `docs/canvas-backdrop/mocks/scene-concepts.html` `sunset()`
 * function (mulberry32 seed 5); the model rebuilds deterministically from that
 * seed at any buffer size, so resize never drifts the look.
 *
 * Perf contract: one canvas, buffer dpr clamped to 1.5, <=30fps via a 33ms
 * frame gate. The rAF loop FULLY stops on stop() -- the layer calls it on
 * unmount and document.hidden -- and under reduced motion start() is a no-op;
 * renderStill() paints exactly one frame (STILL_T = 8s, a gentle shimmer phase).
 * All motion is absolute-time driven (pause/resume = phase jump; no accumulated
 * state). The only animated element is the sea ripple dashes: each drifts
 * horizontally with a slow sin wave and pulses alpha gently. Sky, sun glow, and
 * clouds are STATIC.
 *
 * Sizing: the handle owns a ResizeObserver on its canvas -- connected by
 * start()/renderStill(), disconnected by stop() -- rebuilding the model at the
 * new buffer size. jsdom-safe: a null 2D context or zero clientWidth falls back
 * to a 1920x1080 buffer and never throws.
 *
 * Mock canvas was 560x315. All geometry is expressed as fractions of W/H and
 * scaled by k = H/315 for line widths, radii, and dash lengths.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 5
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 8 // a pleasant mid-shimmer phase for the still export
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mock-identical) so seed 5 reproduces the approved pixels. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- scene model (built once per seed/size) ---------- */

/**
 * One ripple dash on the sea surface. All random values are fixed in buildScene;
 * renderScene animates position/alpha purely from t + these stored values.
 */
interface Dash {
  /** Base x as a fraction of W (0..1). */
  baseXFrac: number
  /** Y position in pixels (scaled to buffer). */
  y: number
  /** Dash half-length in pixels (scaled). */
  halfLen: number
  /** True when this dash is near the sun's vertical path (warmer + brighter). */
  nearPath: boolean
  /** Base alpha (centre of the pulse range). */
  baseAlpha: number
  /** Per-dash phase offset for the drift/shimmer animation. */
  phase: number
  /** Horizontal drift amplitude in pixels. */
  driftAmp: number
  /** Stroke color resolved once so renderScene never branches on nearPath. */
  color: string
  /** Fractional t from horizon (0=top, 1=bottom) -- used for lineWidth scaling. */
  tFrac: number
}

interface SceneModel {
  W: number
  H: number
  /** Horizon y in pixels. */
  hz: number
  /** Sun x in pixels. */
  sx: number
  /** Sun y in pixels. */
  sy: number
  /** Scale factor for line widths / radii (H/315). */
  k: number
  dashes: Dash[]
}

/**
 * buildScene is the ONLY place rnd() is called -- it fixes every random value
 * once. Sun position and cloud rects are fixed (the mock hardcodes them as
 * fractions, so they scale deterministically without consuming RNG).
 */
function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const hz = H * 0.62
  const sx = W * 0.6
  const sy = hz - H * (16 / 315) // mock: sy = hz - 16, at H=315
  const k = H / 315

  const dashes: Dash[] = []
  for (let d = 0; d < 150; d++) {
    const dy = hz + 4 * k + rnd() * (H - hz - 8 * k)
    const tFrac = (dy - hz) / (H - hz)
    const baseXFrac = rnd()
    const rawLen = (6 + rnd() * 22) * k
    const nearPath = Math.abs(baseXFrac * W - sx) < (22 + tFrac * 60) * k
    const baseAlpha = nearPath ? 0.25 + rnd() * 0.45 : 0.06 + rnd() * 0.12
    const phase = rnd() * TAU
    // drift amplitude: a small horizontal sway (~8px at 1080p)
    const driftAmp = (4 + rnd() * 8) * k
    dashes.push({
      baseXFrac,
      y: dy,
      halfLen: rawLen / 2,
      nearPath,
      baseAlpha,
      phase,
      driftAmp,
      color: nearPath ? '#ffd28f' : '#8f7ab8',
      tFrac
    })
  }

  return { W, H, hz, sx, sy, k, dashes }
}

/* ---------- inline rounded-rect helper (ported from mock rr()) ---------- */
type Ctx = CanvasRenderingContext2D

function rr(x: Ctx, px: number, py: number, w: number, h: number, r: number): void {
  x.beginPath()
  x.moveTo(px + r, py)
  x.arcTo(px + w, py, px + w, py + h, r)
  x.arcTo(px + w, py + h, px, py + h, r)
  x.arcTo(px, py + h, px, py, r)
  x.arcTo(px, py, px + w, py, r)
  x.closePath()
  x.fill()
}

/* ---------- renderScene: pure fn of (model, t), never calls rnd() ---------- */

/**
 * Render one frame of the Sunset Ocean scene.
 *
 * Layers (back to front):
 *   1. Sky gradient (violet top -> orange horizon)
 *   2. Sun glow radial gradient + sun disc
 *   3. Dusk clouds (4 rounded rects, dark translucent)
 *   4. Sea gradient
 *   5. Ripple dashes (animated: drift x + pulse alpha)
 *
 * globalAlpha is reset to 1 before returning.
 */
function renderScene(x: Ctx, t: number, S: SceneModel): void {
  const { W, H, hz, sx, sy, k, dashes } = S

  // --- sky gradient ---
  const skyG = x.createLinearGradient(0, 0, 0, hz)
  skyG.addColorStop(0, '#241335')
  skyG.addColorStop(0.45, '#6e2b50')
  skyG.addColorStop(0.82, '#d96a3e')
  skyG.addColorStop(1, '#ffb061')
  x.fillStyle = skyG
  x.fillRect(0, 0, W, hz)

  // --- sun glow (radial, 90px radius scaled) ---
  const glowR = 90 * k
  const glow = x.createRadialGradient(sx, sy, 0, sx, sy, glowR)
  glow.addColorStop(0, 'rgba(255,225,160,.55)')
  glow.addColorStop(1, 'rgba(255,225,160,0)')
  x.fillStyle = glow
  x.fillRect(sx - glowR, sy - glowR, glowR * 2, glowR * 2)

  // --- sun disc (r=24 in mock at H=315) ---
  x.fillStyle = '#ffe9b0'
  x.beginPath()
  x.arc(sx, sy, 24 * k, 0, TAU)
  x.fill()

  // --- dusk clouds (4 rounded rects from mock, fractions of W/hz) ---
  x.fillStyle = 'rgba(38,16,48,.75)'
  // mock coords: [xFrac, yFrac_of_hz, w_px, h_px, r=5] at W=560, H=315, hz=315*0.62
  // scaled: x*W, y*hz, w*(W/560), h*(H/315), r*(H/315)
  const cloudDefs: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.1, 0.2, 150, 10],
    [0.32, 0.3, 110, 8],
    [0.62, 0.16, 170, 11],
    [0.78, 0.34, 90, 7]
  ]
  for (const [cxf, cyf, cw, ch] of cloudDefs) {
    rr(x, cxf * W, cyf * hz, cw * (W / 560), ch * k, 5 * k)
  }

  // --- sea gradient ---
  const seaG = x.createLinearGradient(0, hz, 0, H)
  seaG.addColorStop(0, '#2a1840')
  seaG.addColorStop(1, '#0d0e22')
  x.fillStyle = seaG
  x.fillRect(0, hz, W, H - hz)

  // --- ripple dashes (animated) ---
  // drift period: 18s (slow horizontal sway); alpha pulse period: 4s
  const driftPeriod = 18
  const alphaPeriod = 4
  for (const dash of dashes) {
    const driftX = Math.sin((TAU / driftPeriod) * t + dash.phase) * dash.driftAmp
    const xx = dash.baseXFrac * W + driftX
    const alphaPulse = 0.5 + 0.5 * Math.sin((TAU / alphaPeriod) * t + dash.phase)
    // pulse range: baseAlpha +/- 30% of baseAlpha, clamped to [0.03, 0.9]
    const alpha = Math.max(
      0.03,
      Math.min(0.9, dash.baseAlpha + (alphaPulse - 0.5) * dash.baseAlpha * 0.6)
    )
    x.globalAlpha = alpha
    x.strokeStyle = dash.color
    x.lineWidth = (1 + dash.tFrac * 1.4) * k
    x.beginPath()
    x.moveTo(xx - dash.halfLen, dash.y)
    x.lineTo(xx + dash.halfLen, dash.y)
    x.stroke()
  }

  x.globalAlpha = 1
}

/* ---------- SceneDef ---------- */

// Inline SVG thumbnail: dusk sky gradient (violet to orange), sun disc, dark
// sea band with a few warm ripple marks. Width 96, height 54.
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<defs>' +
      '<linearGradient id="sk" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#241335"/>' +
      '<stop offset="0.5" stop-color="#6e2b50"/>' +
      '<stop offset="0.85" stop-color="#d96a3e"/>' +
      '<stop offset="1" stop-color="#ffb061"/>' +
      '</linearGradient>' +
      '<radialGradient id="gl" cx="60%" cy="100%" r="30%">' +
      '<stop offset="0" stop-color="rgba(255,225,160,0.6)"/>' +
      '<stop offset="1" stop-color="rgba(255,225,160,0)"/>' +
      '</radialGradient>' +
      '<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#2a1840"/>' +
      '<stop offset="1" stop-color="#0d0e22"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect width="96" height="34" fill="url(#sk)"/>' +
      '<rect width="96" height="34" fill="url(#gl)"/>' +
      '<circle cx="58" cy="32" r="5" fill="#ffe9b0"/>' +
      '<rect y="34" width="96" height="20" fill="url(#sea)"/>' +
      '<line x1="50" y1="38" x2="62" y2="38" stroke="#ffd28f" stroke-width="1.2" opacity="0.7"/>' +
      '<line x1="54" y1="42" x2="64" y2="42" stroke="#ffd28f" stroke-width="1" opacity="0.5"/>' +
      '<line x1="20" y1="40" x2="32" y2="40" stroke="#8f7ab8" stroke-width="1" opacity="0.4"/>' +
      '<line x1="76" y1="45" x2="86" y2="45" stroke="#8f7ab8" stroke-width="1" opacity="0.35"/>' +
      '</svg>'
  )

export const sunsetOcean: SceneDef = {
  id: 'sunset-ocean',
  label: 'Sunset Ocean',
  tier: 'scenic',
  thumb: THUMB,
  create(canvas: HTMLCanvasElement, opts: SceneOpts): SceneHandle {
    const ctx = canvas.getContext('2d')
    let model: SceneModel | null = null
    let running = false
    let raf = 0
    let lastDraw = 0
    let ro: ResizeObserver | null = null

    /** Match the buffer to the element (dpr clamped); rebuild the model on change. */
    const ensureSize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CLAMP)
      const w = canvas.clientWidth > 0 ? Math.round(canvas.clientWidth * dpr) : FALLBACK_W
      const h = canvas.clientHeight > 0 ? Math.round(canvas.clientHeight * dpr) : FALLBACK_H
      if (model !== null && w === canvas.width && h === canvas.height) return
      canvas.width = w
      canvas.height = h
      model = buildScene(w, h, mulberry32(SEED))
    }

    const paint = (t: number): void => {
      if (ctx === null || model === null) return
      renderScene(ctx, t, model)
    }

    const observe = (): void => {
      if (ro !== null || typeof ResizeObserver === 'undefined') return
      ro = new ResizeObserver(() => {
        const before = model
        ensureSize()
        // The live loop repaints itself on the next frame; a parked still must
        // repaint here or it would stay stretched at the old composition.
        if (model !== before && !running) paint(STILL_T)
      })
      ro.observe(canvas)
    }

    const tick = (now: number): void => {
      if (!running) return
      if (lastDraw === 0 || now - lastDraw >= FRAME_MS) {
        lastDraw = now
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
        paint(STILL_T)
      }
    }
  }
}

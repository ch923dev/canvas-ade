/**
 * Aurora Night -- a faithful port of the approved mock aurora(x, R) paint function
 * from docs/canvas-backdrop/mocks/scene-concepts.html (lines 107-154), mulberry32
 * seed 11. The scene is a dark arctic sky with ~170 stars, three additive aurora
 * curtain bands (teal, cyan, violet) undulating across the upper sky, and a dark
 * ridge silhouette in the foreground. All positions, sizes, and ridge polyline
 * points are fixed once in buildScene(); renderScene() is a pure function of (model,
 * t) and never calls the RNG. Animation: each aurora band's horizontal sine phase
 * shifts at TAU/20 rad/s (~20s period) and its base Y breathes by +-4px at 0.07
 * rad/s; stars and ridge are static. Perf contract: one canvas, buffer dpr clamped
 * to 1.5, <=30fps via a 33ms frame gate. The rAF loop fully stops on stop(); under
 * reduced motion start() is a no-op and renderStill() paints one frame at STILL_T=6
 * (a pleasant aurora phase). A ResizeObserver on the canvas rebuilds the model at
 * the new buffer size; a parked still re-paints after rebuild. jsdom-safe: a null 2D
 * context or zero clientWidth falls back to a 1920x1080 buffer and never throws.
 * globalCompositeOperation and globalAlpha are reset to defaults before returning
 * from renderScene so the next frame starts clean.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 11
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 6 // pleasant aurora phase for the static/reduced-motion frame
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mulberry32) -- seed 11 reproduces the approved pixels. */
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

/** A single star: position, size (large vs small), and base alpha. */
interface Star {
  x: number
  y: number
  large: boolean
  alpha: number
}

/** The aurora band definition (geometry fixed at build time; phase injected at render). */
interface AuroraBand {
  color: string // rgba prefix e.g. 'rgba(64,224,160,'
  y: number // base Y in buffer pixels
  amp: number // sine amplitude in buffer pixels
  wl: number // wavelength factor (per pixel, pre-scaled)
  ph: number // initial phase (radians)
  len: number // gradient length in buffer pixels
  a: number // peak alpha
}

/** Ridge polyline vertex (x, y in buffer pixels). */
interface RidgePoint {
  x: number
  y: number
}

interface SceneModel {
  W: number
  H: number
  stars: Star[]
  bands: AuroraBand[]
  ridge: RidgePoint[]
}

// The mock authored at W=560, H=315. All geometry is expressed as fractions
// of those reference dimensions so it scales correctly at any buffer size.
const REF_W = 560
const REF_H = 315

function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const sx = W / REF_W
  const sy = H / REF_H

  // ~170 stars in the upper 72% of the sky (matching the mock loop)
  const stars: Star[] = []
  for (let i = 0; i < 170; i++) {
    const alpha = 0.15 + rnd() * 0.65
    const large = rnd() >= 0.93 // probability matches the mock ternary (R()<0.93 -> small)
    stars.push({
      x: rnd() * W,
      y: rnd() * H * 0.72,
      large,
      alpha
    })
  }

  // Three aurora bands (proportions from the mock, scaled to buffer)
  const bands: AuroraBand[] = [
    {
      color: 'rgba(64,224,160,',
      y: H * 0.34,
      amp: 24 * sy,
      wl: 0.013 / sx,
      ph: 0.5,
      len: 120 * sy,
      a: 0.16
    },
    {
      color: 'rgba(90,208,200,',
      y: H * 0.46,
      amp: 32 * sy,
      wl: 0.009 / sx,
      ph: 2.4,
      len: 150 * sy,
      a: 0.12
    },
    {
      color: 'rgba(140,120,255,',
      y: H * 0.27,
      amp: 18 * sy,
      wl: 0.016 / sx,
      ph: 4.4,
      len: 95 * sy,
      a: 0.09
    }
  ]

  // Ridge silhouette: walk from left to right, clamped to [72%,93%] of H,
  // starting near H*0.84 with steps every 8 ref-px (scaled)
  const stepPx = Math.round(8 * sx)
  const jitter = 11 * sy
  const ridgeMin = H * 0.72
  const ridgeMax = H * 0.93
  const ridge: RidgePoint[] = []
  let ry = H * 0.84
  for (let px = 0; px <= W; px += stepPx) {
    ry += (rnd() - 0.5) * jitter
    ry = Math.max(ridgeMin, Math.min(ridgeMax, ry))
    ridge.push({ x: px, y: ry })
  }

  return { W, H, stars, bands, ridge }
}

/* ---------- render (pure function of model + t) ---------- */

type Ctx = CanvasRenderingContext2D

function renderScene(ctx: Ctx, t: number, model: SceneModel): void {
  const { W, H, stars, bands, ridge } = model
  const k = H / REF_H // stroke/radius scale factor

  // 1. Sky gradient
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0, '#04060e')
  skyGrad.addColorStop(0.6, '#081421')
  skyGrad.addColorStop(1, '#0d1d2b')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // 2. Stars (static -- positions/sizes fixed in model)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#cfe2ff'
  for (const s of stars) {
    ctx.globalAlpha = s.alpha
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.large ? 1.5 * k : 0.7 * k, 0, TAU)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // 3. Aurora curtain bands (additive blend; phase animated by t)
  ctx.globalCompositeOperation = 'lighter'
  const phaseShift = (TAU / 20) * t // ~20s full-cycle sway
  const breatheAmp = 4 * k // subtle vertical breathing
  const breatheRate = 0.07 // rad/s -- slow inhale/exhale

  for (const bd of bands) {
    // Animate: horizontal phase shifts over time; base Y breathes gently
    const animPh = bd.ph + phaseShift
    const baseY = bd.y + Math.sin(t * breatheRate + bd.ph) * breatheAmp

    // Column-by-column gradient curtain (3px-wide columns matching the mock)
    const colW = Math.max(1, Math.round(3 * (W / REF_W)))
    for (let px = 0; px < W; px += colW) {
      const yTop =
        baseY +
        Math.sin(px * bd.wl + animPh) * bd.amp +
        Math.sin(px * (0.004 / (W / REF_W)) + animPh) * 34 * k
      const gr = ctx.createLinearGradient(0, yTop, 0, yTop + bd.len)
      gr.addColorStop(0, bd.color + '0)')
      gr.addColorStop(0.35, bd.color + bd.a + ')')
      gr.addColorStop(1, bd.color + '0)')
      ctx.fillStyle = gr
      ctx.fillRect(px, yTop, colW, bd.len)
    }
  }

  // Reset composite before ridge
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1

  // 4. Ridge silhouette (static polyline, dark fill to bottom)
  ctx.fillStyle = '#05080d'
  ctx.beginPath()
  ctx.moveTo(0, H)
  for (const pt of ridge) {
    ctx.lineTo(pt.x, pt.y)
  }
  ctx.lineTo(W, H)
  ctx.closePath()
  ctx.fill()

  // Reset compositing to defaults before returning
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/* ---------- SceneDef ---------- */

const thumb =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<defs>' +
      '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#04060e"/>' +
      '<stop offset="0.6" stop-color="#081421"/>' +
      '<stop offset="1" stop-color="#0d1d2b"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect width="96" height="54" fill="url(#sky)"/>' +
      // stars
      '<circle cx="12" cy="6" r="0.7" fill="#cfe2ff" opacity="0.7"/>' +
      '<circle cx="28" cy="10" r="0.7" fill="#cfe2ff" opacity="0.5"/>' +
      '<circle cx="48" cy="5" r="0.7" fill="#cfe2ff" opacity="0.8"/>' +
      '<circle cx="68" cy="8" r="0.7" fill="#cfe2ff" opacity="0.6"/>' +
      '<circle cx="82" cy="4" r="1.2" fill="#cfe2ff" opacity="0.5"/>' +
      '<circle cx="6" cy="14" r="0.7" fill="#cfe2ff" opacity="0.4"/>' +
      '<circle cx="90" cy="12" r="0.7" fill="#cfe2ff" opacity="0.6"/>' +
      // aurora band (teal) -- approximated as a blurred rect
      '<rect x="0" y="15" width="96" height="14" fill="rgba(64,224,160,0.13)" rx="2"/>' +
      '<rect x="0" y="17" width="96" height="8" fill="rgba(64,224,160,0.18)" rx="1"/>' +
      // aurora band (violet hint)
      '<rect x="0" y="10" width="96" height="10" fill="rgba(140,120,255,0.07)" rx="2"/>' +
      // ridge
      '<path d="M0 54 L0 44 L12 40 L20 42 L30 38 L40 41 L52 36 L64 40 L76 38 L88 42 L96 39 L96 54 Z" fill="#05080d"/>' +
      '</svg>'
  )

export const auroraNight: SceneDef = {
  id: 'aurora-night',
  label: 'Aurora Night',
  tier: 'scenic',
  thumb,
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
        // A parked still must repaint after a resize so it does not stay
        // stretched at the old composition; the live loop repaints on next frame.
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

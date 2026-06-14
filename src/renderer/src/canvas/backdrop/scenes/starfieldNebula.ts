/**
 * Starfield Nebula -- a scenic backdrop ported from the approved mock
 * `docs/canvas-backdrop/mocks/scene-concepts.html` `nebula(x, R)` function
 * (mulberry32 seed 23). The model is built deterministically from that seed at
 * any buffer size; resize rebuilds cleanly and never drifts the look.
 *
 * Perf contract: one canvas, buffer dpr clamped to 1.5, <=30fps via a 33ms frame
 * gate. The rAF loop fully stops on stop() -- called on unmount / document.hidden --
 * and under reduced motion start() is a no-op; renderStill() paints exactly one
 * frame (STILL_T = 0, the "neutral twinkle phase"). All motion is absolute-time
 * driven (pause/resume = phase jump; no accumulated state).
 *
 * Animation: SLOW TWINKLE ONLY -- near-static. Each star's alpha oscillates on a
 * period drawn from {8, 10, 12, 14, 16} seconds (varied per star via a small integer
 * harmonic). Nebula blobs and cross flares are fully static. Reduced-motion / still
 * = renderScene(ctx, STILL_T, model).
 *
 * Sizing: a ResizeObserver on the canvas -- connected by start()/renderStill(),
 * disconnected by stop() -- rebuilds the model at the new buffer size (a
 * reduced-motion still re-paints; the live loop repaints on the next tick).
 * jsdom-safe: a null 2D context or zero clientWidth falls back to 1920x1080
 * and never throws.
 *
 * Geometry authored at 560x315 (mock viewport). All radii/line widths scale by
 * k = H / 315 so the composition matches the mock at 1080p.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 23
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 0 // neutral twinkle phase (sin(0) = 0 -> alpha at 0.6 weight)
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mock-identical) so seed 23 reproduces the approved pixels. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- palette (mock-identical) ---------- */
// nebula blob color channels (rgb strings for rgba() construction)
const NEBULA_COLS = ['123,91,214', '199,91,158', '58,167,160', '91,124,214'] as const

/* ---------- scene model (built once per seed/size) ---------- */
interface NebulaBlob {
  /** x position as fraction of W */
  xf: number
  /** y position as fraction of H */
  yf: number
  /** radius as fraction of H (scaled from mock's 560x315 space) */
  rf: number
  /** index into NEBULA_COLS */
  col: number
}

/** Twinkle periods in seconds, indexed by (harmonic % 5). */
const TWINKLE_PERIODS = [8, 10, 12, 14, 16] as const

interface Star {
  /** x position as fraction of W */
  xf: number
  /** y position as fraction of H */
  yf: number
  /** true = large star (r=1.6k), false = small (r=0.8k) */
  large: boolean
  /** true = warm tint (#ffe9c9), false = cool (#dfe8ff) */
  warm: boolean
  /** base alpha before twinkle modulation (0.2 to 0.95) */
  baseAlpha: number
  /** twinkle phase offset in radians */
  phase: number
  /** index into TWINKLE_PERIODS */
  harmonic: number
}

interface CrossFlare {
  /** x position as fraction of W */
  xf: number
  /** y position as fraction of H */
  yf: number
  /** arm radius as fraction of H */
  rf: number
}

interface SceneModel {
  W: number
  H: number
  /** k = H / 315 -- the geometric scale factor */
  k: number
  blobs: NebulaBlob[]
  stars: Star[]
  flares: CrossFlare[]
}

/** Build the scene model; rnd() must only be called here. */
function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const k = H / 315

  // 16 nebula radial blobs -- positions and radii authored in mock space (560x315),
  // stored as fractions so they work at any buffer size.
  const blobs: NebulaBlob[] = []
  for (let i = 0; i < 16; i++) {
    const t = i / 16
    // mock: bx = t*W + (R()-0.5)*120, by = H*0.15 + t*H*0.6 + (R()-0.5)*70, r = 55+R()*95
    // convert to fractions of the 560x315 mock space
    const bx = t * 560 + (rnd() - 0.5) * 120
    const by = 315 * 0.15 + t * 315 * 0.6 + (rnd() - 0.5) * 70
    const r = 55 + rnd() * 95
    const colIdx = (rnd() * NEBULA_COLS.length) | 0
    blobs.push({
      xf: bx / 560,
      yf: by / 315,
      rf: r / 315,
      col: colIdx
    })
  }

  // ~300 band-biased stars
  const stars: Star[] = []
  for (let s = 0; s < 300; s++) {
    const sxf = rnd()
    const syf = rnd()
    // band test: abs(sy/H - (sx/W)*0.6 - 0.18) < 0.18
    const onBand = Math.abs(syf - sxf * 0.6 - 0.18) < 0.18
    if (!onBand && rnd() < 0.45) continue
    const baseAlpha = 0.2 + rnd() * 0.75
    const large = rnd() >= 0.9
    const warm = rnd() >= 0.85
    const phase = rnd() * TAU
    const harmonic = (s % 5) as 0 | 1 | 2 | 3 | 4
    stars.push({ xf: sxf, yf: syf, large, warm, baseAlpha, phase, harmonic })
  }

  // 5 cross flares; radii authored in mock space (3+R()*4 px at 315H -> fraction)
  const flares: CrossFlare[] = []
  for (let f = 0; f < 5; f++) {
    const fxf = rnd()
    const fyf = rnd()
    const fr = 3 + rnd() * 4
    flares.push({ xf: fxf, yf: fyf, rf: fr / 315 })
  }

  return { W, H, k, blobs, stars, flares }
}

/* ---------- renderer (pure function of model + t) ---------- */
type Ctx = CanvasRenderingContext2D

/**
 * Paint one frame. t is absolute time in seconds.
 * globalCompositeOperation and globalAlpha are reset to defaults before returning.
 */
function renderScene(ctx: Ctx, t: number, model: SceneModel): void {
  const { W, H, k, blobs, stars, flares } = model

  // background fill
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = '#05050b'
  ctx.fillRect(0, 0, W, H)

  // nebula blobs in 'lighter' composite (additive glow)
  ctx.globalCompositeOperation = 'lighter'
  for (const blob of blobs) {
    const bx = blob.xf * W
    const by = blob.yf * H
    const r = blob.rf * H
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, r)
    const c = NEBULA_COLS[blob.col]
    g.addColorStop(0, 'rgba(' + c + ',.14)')
    g.addColorStop(1, 'rgba(' + c + ',0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(bx, by, r, 0, TAU)
    ctx.fill()
  }

  // stars -- source-over with per-star twinkle alpha
  ctx.globalCompositeOperation = 'source-over'
  for (const star of stars) {
    const period = TWINKLE_PERIODS[star.harmonic]
    const alpha = star.baseAlpha * (0.6 + 0.4 * Math.sin((TAU / period) * t + star.phase))
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
    ctx.fillStyle = star.warm ? '#ffe9c9' : '#dfe8ff'
    const r = star.large ? 1.6 * k : 0.8 * k
    ctx.beginPath()
    ctx.arc(star.xf * W, star.yf * H, r, 0, TAU)
    ctx.fill()
  }

  // reset alpha before flares
  ctx.globalAlpha = 1

  // 5 cross flares -- static (no twinkle)
  ctx.strokeStyle = 'rgba(230,240,255,.5)'
  ctx.lineWidth = 0.8 * k
  for (const flare of flares) {
    const fx = flare.xf * W
    const fy = flare.yf * H
    const fr = flare.rf * H
    ctx.beginPath()
    ctx.moveTo(fx - fr, fy)
    ctx.lineTo(fx + fr, fy)
    ctx.moveTo(fx, fy - fr)
    ctx.lineTo(fx, fy + fr)
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(fx, fy, 1.1 * k, 0, TAU)
    ctx.fill()
  }

  // reset composite state to defaults
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/* ---------- SceneDef ---------- */
// Inline SVG thumb: near-black space, diagonal nebula smear (purple/teal), white stars.
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<rect width="96" height="54" fill="#05050b"/>' +
      '<defs>' +
      '<radialGradient id="n1" cx="30%" cy="40%" r="55%">' +
      '<stop offset="0" stop-color="rgba(123,91,214,0.55)"/>' +
      '<stop offset="1" stop-color="rgba(123,91,214,0)"/>' +
      '</radialGradient>' +
      '<radialGradient id="n2" cx="65%" cy="55%" r="50%">' +
      '<stop offset="0" stop-color="rgba(58,167,160,0.5)"/>' +
      '<stop offset="1" stop-color="rgba(58,167,160,0)"/>' +
      '</radialGradient>' +
      '<radialGradient id="n3" cx="50%" cy="35%" r="45%">' +
      '<stop offset="0" stop-color="rgba(199,91,158,0.4)"/>' +
      '<stop offset="1" stop-color="rgba(199,91,158,0)"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<rect width="96" height="54" fill="url(#n1)"/>' +
      '<rect width="96" height="54" fill="url(#n2)"/>' +
      '<rect width="96" height="54" fill="url(#n3)"/>' +
      '<circle cx="12" cy="8" r="1" fill="#dfe8ff"/>' +
      '<circle cx="27" cy="14" r="0.8" fill="#dfe8ff"/>' +
      '<circle cx="42" cy="6" r="1" fill="#fff"/>' +
      '<circle cx="58" cy="20" r="1.2" fill="#dfe8ff"/>' +
      '<circle cx="71" cy="9" r="0.8" fill="#ffe9c9"/>' +
      '<circle cx="85" cy="16" r="1" fill="#dfe8ff"/>' +
      '<circle cx="19" cy="32" r="0.8" fill="#dfe8ff"/>' +
      '<circle cx="35" cy="40" r="1" fill="#fff"/>' +
      '<circle cx="52" cy="36" r="0.8" fill="#dfe8ff"/>' +
      '<circle cx="68" cy="44" r="1" fill="#dfe8ff"/>' +
      '<circle cx="80" cy="30" r="1.2" fill="#ffe9c9"/>' +
      '<circle cx="90" cy="42" r="0.8" fill="#dfe8ff"/>' +
      '<line x1="48" y1="23" x2="52" y2="23" stroke="rgba(230,240,255,.5)" stroke-width="0.6"/>' +
      '<line x1="50" y1="21" x2="50" y2="25" stroke="rgba(230,240,255,.5)" stroke-width="0.6"/>' +
      '<circle cx="50" cy="23" r="1" fill="#fff"/>' +
      '</svg>'
  )

export const starfieldNebula: SceneDef = {
  id: 'starfield-nebula',
  label: 'Starfield Nebula',
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
        // Self-correct on a dpr change (window moved across displays) — the
        // ResizeObserver only fires on CSS-box changes, not dpr changes.
        // ensureSize() early-returns when the buffer is unchanged.
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
        paint(STILL_T)
      }
    }
  }
}

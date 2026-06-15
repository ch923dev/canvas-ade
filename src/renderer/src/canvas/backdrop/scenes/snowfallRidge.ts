/**
 * Snowfall Ridge -- a night winter scene (PR 3, scenic roster). A faithful port of
 * the approved concept `docs/canvas-backdrop/mocks/scene-concepts.html` snow(x, R)
 * (mulberry32 seed 17); the model rebuilds deterministically from that seed at any
 * buffer size so resize never drifts the look.
 *
 * Perf contract: one canvas, buffer dpr clamped to 1.5, <=30fps via a 33ms frame
 * gate. The rAF loop FULLY stops on stop() -- the layer calls it on unmount and
 * document.hidden -- and under reduced motion start() is a no-op; renderStill()
 * paints exactly one frame (t=10s, snow mid-fall, a pleasant static composition).
 * All motion is absolute-time driven (pause/resume = phase jump; no accumulated state).
 *
 * Sizing: the handle owns a ResizeObserver on its canvas -- connected by
 * start()/renderStill(), disconnected by stop() -- rebuilding the model at the new
 * buffer size (a reduced-motion still re-paints; the live loop repaints itself on
 * the next frame). jsdom-safe: a null 2D context or zero clientWidth falls back to
 * a 1920x1080 buffer and never throws.
 *
 * Animation: ONLY snow drifts. Each flake falls at a gentle absolute speed
 * (H*0.02..H*0.06 px/s) with a subtle horizontal sway. Sky, moon, ridges, and pines
 * are fully static -- painted from the fixed model. globalAlpha is always reset to 1
 * before renderScene returns.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 17
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 10 // snow mid-fall; a pleasant static frame
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mock-identical) so seed 17 reproduces the approved pixels. */
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
interface Ridge {
  /** Polyline x coords spaced 10px-equivalent apart. */
  xs: number[]
  /** Polyline y coords corresponding to xs. */
  ys: number[]
  color: string
  /** Baseline fraction of H (ridge center). */
  base: number
}

interface Pine {
  /** Center x. */
  tx: number
  /** Tip y. */
  ty: number
  /** Height in px. */
  th: number
}

interface Flake {
  baseX: number
  baseY: number
  /** Fall speed px/s. */
  speed: number
  /** Dot radius in px. */
  radius: number
  /** Horizontal sway amplitude px. */
  swayAmp: number
  /** Phase offset for sway sin. */
  swayPhase: number
  /** Alpha (0.25..0.9). */
  alpha: number
}

interface SceneModel {
  W: number
  H: number
  /** Scaling factor relative to the mock's 315px height. */
  k: number
  /** Moon center x. */
  mx: number
  /** Moon center y. */
  my: number
  /** Moon disc radius px. */
  moonR: number
  /** Moon halo radius px (mock used 60px at 315px height). */
  haloR: number
  ridges: Ridge[]
  pines: Pine[]
  flakes: Flake[]
}

/** Build the 3 layered ridges as random-walk polylines. */
function buildRidge(
  W: number,
  H: number,
  color: string,
  base: number,
  amplitude: number,
  rnd: () => number
): Ridge {
  const stepPx = 10
  const xs: number[] = []
  const ys: number[] = []
  let y = H * base
  const yMin = H * (base - 0.14)
  const yMax = H * (base + 0.1)
  for (let px = 0; px <= W; px += stepPx) {
    y += (rnd() - 0.5) * amplitude * 0.45
    y = Math.max(yMin, Math.min(yMax, y))
    xs.push(px)
    ys.push(y)
  }
  return { xs, ys, color, base }
}

function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const k = H / 315

  // Moon -- fixed position (fractions from mock: W*0.78, H*0.2)
  const mx = W * 0.78
  const my = H * 0.2
  const moonR = 15 * k
  const haloR = 60 * k

  // 3 ridges: far (b=0.62), mid (b=0.74), near (b=0.88)
  // Amplitude in mock pixels (a field): 30, 36, 42 -- scale by k
  const ridgeDefs: Array<{ c: string; b: number; a: number }> = [
    { c: '#121b29', b: 0.62, a: 30 * k },
    { c: '#0d1420', b: 0.74, a: 36 * k },
    { c: '#070c14', b: 0.88, a: 42 * k }
  ]
  const ridges: Ridge[] = ridgeDefs.map((rd) => buildRidge(W, H, rd.c, rd.b, rd.a, rnd))

  // 26 pines planted on the nearest ridge (r0===2, b=0.88)
  // Mock: tx=R()*W, th=(10+R()*22)px scaled, ty=H*b + (R()-0.5)*16px scaled
  const nearBase = 0.88
  const pines: Pine[] = []
  for (let p = 0; p < 26; p++) {
    const tx = rnd() * W
    const th = (10 + rnd() * 22) * k
    const ty = H * nearBase + (rnd() - 0.5) * 16 * k
    pines.push({ tx, ty, th })
  }

  // ~150 snow flakes: fix all random attrs here; animation is purely t-driven.
  // Fall speed: H*0.02..H*0.06 px/s (gentle drift). Sway uses the module-level
  // SWAY_PERIOD so renderScene can stay a pure (model, t) function.
  const flakes: Flake[] = []
  for (let i = 0; i < 150; i++) {
    flakes.push({
      baseX: rnd() * W,
      baseY: rnd() * H,
      speed: H * (0.02 + rnd() * 0.04),
      radius: (0.7 + rnd() * 1.8) * k,
      swayAmp: (4 + rnd() * 10) * k,
      swayPhase: rnd() * TAU,
      alpha: 0.25 + rnd() * 0.65
    })
  }

  return { W, H, k, mx, my, moonR, haloR, ridges, pines, flakes }
}

/* ---------- painter ---------- */
type Ctx = CanvasRenderingContext2D

// Shared sway period constant used in renderScene (must match what buildScene assumes).
const SWAY_PERIOD = 8 // seconds

function renderScene(ctx: Ctx, t: number, model: SceneModel): void {
  const { W, H, mx, my, moonR, haloR, ridges, pines, flakes } = model

  // -- sky gradient (night, dark blue) --
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#0a0f18')
  g.addColorStop(1, '#18222f')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // -- moon halo (radial glow) --
  const halo = ctx.createRadialGradient(mx, my, 0, mx, my, haloR)
  halo.addColorStop(0, 'rgba(214,228,255,0.35)')
  halo.addColorStop(1, 'rgba(214,228,255,0)')
  ctx.fillStyle = halo
  ctx.fillRect(mx - haloR, my - haloR, haloR * 2, haloR * 2)

  // -- moon disc --
  ctx.fillStyle = '#dce6f5'
  ctx.beginPath()
  ctx.arc(mx, my, moonR, 0, TAU)
  ctx.fill()

  // -- ridges (far to near, layered) --
  for (const rd of ridges) {
    ctx.fillStyle = rd.color
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let i = 0; i < rd.xs.length; i++) {
      ctx.lineTo(rd.xs[i], rd.ys[i])
    }
    ctx.lineTo(W, H)
    ctx.closePath()
    ctx.fill()
  }

  // -- pine triangles on nearest ridge --
  ctx.fillStyle = '#04070c'
  for (const pine of pines) {
    ctx.beginPath()
    ctx.moveTo(pine.tx, pine.ty - pine.th)
    ctx.lineTo(pine.tx - pine.th * 0.32, pine.ty)
    ctx.lineTo(pine.tx + pine.th * 0.32, pine.ty)
    ctx.closePath()
    ctx.fill()
  }

  // -- snow: each flake drifts down (absolute-time driven, modulo wrap) --
  // Radius/speed already scaled by k at buildScene time; use H for the wrap.
  for (const flake of flakes) {
    const yy = (((flake.baseY + flake.speed * t) % H) + H) % H
    const xx = flake.baseX + flake.swayAmp * Math.sin((TAU / SWAY_PERIOD) * t + flake.swayPhase)
    ctx.globalAlpha = flake.alpha
    ctx.fillStyle = '#eef4ff'
    ctx.beginPath()
    ctx.arc(xx, yy, flake.radius, 0, TAU)
    ctx.fill()
  }

  // Always reset globalAlpha before returning.
  ctx.globalAlpha = 1
}

/* ---------- SceneDef ---------- */
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<defs>' +
      '<linearGradient id="sk" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0a0f18"/><stop offset="1" stop-color="#18222f"/>' +
      '</linearGradient>' +
      '<radialGradient id="hl" cx="75%" cy="18%" r="12%">' +
      '<stop offset="0" stop-color="rgba(214,228,255,0.45)"/>' +
      '<stop offset="1" stop-color="rgba(214,228,255,0)"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<rect width="96" height="54" fill="url(#sk)"/>' +
      '<rect width="96" height="54" fill="url(#hl)"/>' +
      '<circle cx="72" cy="10" r="4" fill="#dce6f5"/>' +
      '<path d="M0 34 Q24 30 48 33 Q72 36 96 31 L96 54 L0 54 Z" fill="#121b29"/>' +
      '<path d="M0 40 Q20 37 48 40 Q72 43 96 38 L96 54 L0 54 Z" fill="#0d1420"/>' +
      '<path d="M0 47 Q24 44 48 47 Q72 50 96 46 L96 54 L0 54 Z" fill="#070c14"/>' +
      '<polygon points="22,47 18,54 26,54" fill="#04070c"/>' +
      '<polygon points="36,46 33,53 39,53" fill="#04070c"/>' +
      '<polygon points="60,48 56,54 64,54" fill="#04070c"/>' +
      '<circle cx="8" cy="12" r="1" fill="#eef4ff" opacity="0.8"/>' +
      '<circle cx="30" cy="8" r="1" fill="#eef4ff" opacity="0.7"/>' +
      '<circle cx="50" cy="20" r="1" fill="#eef4ff" opacity="0.9"/>' +
      '<circle cx="14" cy="28" r="1" fill="#eef4ff" opacity="0.6"/>' +
      '<circle cx="42" cy="15" r="1" fill="#eef4ff" opacity="0.75"/>' +
      '<circle cx="68" cy="26" r="1" fill="#eef4ff" opacity="0.8"/>' +
      '<circle cx="82" cy="18" r="1" fill="#eef4ff" opacity="0.65"/>' +
      '</svg>'
  )

export const snowfallRidge: SceneDef = {
  id: 'snowfall-ridge',
  label: 'Snowfall Ridge',
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

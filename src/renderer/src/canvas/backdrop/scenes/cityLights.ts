/**
 * City Lights -- a night-city backdrop scene (PR 3, scenic tier). A faithful port of
 * the approved mock `docs/canvas-backdrop/mocks/scene-concepts.html` city() function
 * (W=560, H=315 in the mock); the model rebuilds deterministically from mulberry32
 * seed 41 at any buffer size, so resize never drifts the composition.
 *
 * Perf contract: one canvas, buffer dpr clamped to 1.5, <=30fps via a 33ms frame gate.
 * The rAF loop FULLY stops on stop() -- the layer calls it on unmount and
 * document.hidden -- and under reduced motion start() is a no-op; renderStill() paints
 * exactly one frame (the t=0 export phase). All motion is absolute-time driven, so a
 * pause/resume just jumps phase (no accumulated state to corrupt).
 *
 * Sizing: the handle owns a ResizeObserver on its canvas -- connected by
 * start()/renderStill(), disconnected by stop() -- rebuilding the model at the new
 * buffer size (a reduced-motion still re-paints; the live loop repaints itself on the
 * next frame). jsdom-safe: a null 2D context or zero clientWidth falls back to a
 * 1920x1080 buffer and never throws.
 *
 * Animation (the mock is static; only these two effects move):
 *   - Window flicker: lit windows occasionally dip to ~25% alpha via a slow sine
 *     (period ~8s) sampled against a -0.85 threshold -- rare, not strobing.
 *   - Antenna beacon blink: red dot pulses between 0.4 and 1.0 alpha (period ~2s).
 *   Stars, sky, horizon glow, and building silhouettes are STATIC.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 41
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 0 // static scene: t=0 is the reference still
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mock-identical) so seed 41 reproduces the approved pixels. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- scene model types ---------- */

interface Star {
  x: number
  y: number
  r: number
  baseAlpha: number
}

interface BackBuilding {
  x: number
  y: number
  w: number
  h: number
}

interface Window {
  x: number
  y: number
  lit: boolean
  warm: boolean
  flickerPhase: number
}

interface FrontBuilding {
  x: number
  y: number
  w: number
  h: number
  hasAntenna: boolean
  antennaX: number
  antennaBaseY: number
  antennaH: number
  beaconPhase: number
  windows: Window[]
}

interface SceneModel {
  W: number
  H: number
  stars: Star[]
  backBuildings: BackBuilding[]
  frontBuildings: FrontBuilding[]
}

/* ---------- model builder -- only place rnd() is called ---------- */

function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  // Scale factor from the mock's 315px height to actual buffer height.
  // All mock geometry was authored at W=560, H=315.
  const k = H / 315

  // Stars: 130 stars scattered in the top half of the canvas.
  const stars: Star[] = []
  for (let s = 0; s < 130; s++) {
    stars.push({
      x: rnd() * W,
      y: rnd() * H * 0.5,
      r: rnd() < 0.94 ? 0.7 * k : 1.3 * k,
      baseAlpha: 0.15 + rnd() * 0.55
    })
  }

  // Back silhouette row: buildings from x=0 across the width.
  const backBuildings: BackBuilding[] = []
  let bx = 0
  while (bx < W) {
    const bw = (26 + rnd() * 38) * k
    const bh = H * (0.3 + rnd() * 0.22)
    backBuildings.push({ x: bx, y: H - bh, w: bw, h: bh })
    bx += bw + rnd() * 8 * k
  }

  // Front building row: taller buildings with antennas + window grids.
  const frontBuildings: FrontBuilding[] = []
  let fx = -10 * k
  while (fx < W) {
    const bw2 = (34 + rnd() * 52) * k
    const bh2 = H * (0.42 + rnd() * 0.3)
    const by2 = H - bh2
    const hasAntenna = rnd() < 0.5
    // Antenna geometry (mast + beacon dot).
    const mastH = (12 + rnd() * 14) * k
    const antennaX = fx + bw2 * 0.5
    const antennaBaseY = by2 - (10 + rnd() * 14) * k // top of mast
    const beaconPhase = rnd() * TAU

    // Window grid: build the full grid once, roll lit/warm per window.
    const windows: Window[] = []
    const stepY = 9 * k
    const stepX = 8 * k
    for (let wy = by2 + 8 * k; wy < H - 8 * k; wy += stepY) {
      for (let wx = fx + 5 * k; wx < fx + bw2 - 6 * k; wx += stepX) {
        const lit = rnd() < 0.16
        const warm = rnd() < 0.7
        const flickerPhase = rnd() * TAU
        windows.push({ x: wx, y: wy, lit, warm, flickerPhase })
      }
    }

    frontBuildings.push({
      x: fx,
      y: by2,
      w: bw2,
      h: bh2,
      hasAntenna,
      antennaX,
      antennaBaseY,
      antennaH: mastH,
      beaconPhase,
      windows
    })
    fx += bw2 + (2 + rnd() * 16) * k
  }

  return { W, H, stars, backBuildings, frontBuildings }
}

/* ---------- renderer -- pure function of (model, t), never calls rnd() ---------- */
type Ctx = CanvasRenderingContext2D

// Window flicker: lit windows dim occasionally. A slow sine (period ~8s) dips below
// -0.85 only rarely, producing a brief ~25% alpha drop instead of strobing.
const FLICKER_PERIOD = 8 // seconds
// Antenna beacon blink: pulses between 0.4 and 1.0 alpha (period ~2s).
const BEACON_PERIOD = 2 // seconds

function renderScene(ctx: Ctx, t: number, model: SceneModel): void {
  const { W, H, stars, backBuildings, frontBuildings } = model
  const k = H / 315

  // --- night sky gradient ---
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0, '#060912')
  skyGrad.addColorStop(0.75, '#0b1322')
  skyGrad.addColorStop(1, '#101a2e')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // --- stars (static, globalAlpha varies per star but not per frame) ---
  ctx.fillStyle = '#cfe0ff'
  for (const s of stars) {
    ctx.globalAlpha = s.baseAlpha
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, TAU)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // --- horizon glow (radial, static) ---
  const hg = ctx.createRadialGradient(W * 0.5, H * 0.95, 0, W * 0.5, H * 0.95, W * 0.55)
  hg.addColorStop(0, 'rgba(50,80,140,0.30)')
  hg.addColorStop(1, 'rgba(50,80,140,0)')
  ctx.fillStyle = hg
  ctx.fillRect(0, 0, W, H)

  // --- back silhouette buildings (static) ---
  ctx.fillStyle = '#0a101c'
  for (const b of backBuildings) {
    ctx.fillRect(b.x, b.y, b.w, b.h)
  }

  // --- front buildings with antennas + animated windows ---
  for (const b of frontBuildings) {
    // Building silhouette (static fill).
    ctx.fillStyle = '#070b13'
    ctx.fillRect(b.x, b.y, b.w, b.h)

    // Antenna: thin mast (static).
    if (b.hasAntenna) {
      ctx.fillStyle = '#070b13'
      ctx.fillRect(b.antennaX - 1 * k, b.antennaBaseY, 2 * k, b.antennaH)

      // Beacon dot: animated alpha pulse.
      const beaconAlpha =
        0.4 + 0.6 * Math.max(0, Math.sin((TAU / BEACON_PERIOD) * t + b.beaconPhase))
      ctx.globalAlpha = beaconAlpha
      ctx.fillStyle = 'rgba(255,90,90,0.9)'
      ctx.beginPath()
      ctx.arc(b.antennaX, b.antennaBaseY - 1.4 * k, 1.4 * k, 0, TAU)
      ctx.fill()
      ctx.globalAlpha = 1
    }

    // Windows: lit ones flicker occasionally, unlit stay dark.
    for (const w of b.windows) {
      if (!w.lit) continue
      // Rare dip: when sin dips below -0.85 the window drops to 0.25 brightness.
      const f = Math.sin((TAU / FLICKER_PERIOD) * t + w.flickerPhase)
      const on = f > -0.85 ? 1 : 0.25
      const baseColor = w.warm ? 'rgba(255,201,126,0.85)' : 'rgba(158,196,255,0.60)'
      ctx.globalAlpha = on
      ctx.fillStyle = baseColor
      ctx.fillRect(w.x, w.y, 3.2 * k, 4 * k)
    }
    ctx.globalAlpha = 1
  }
}

/* ---------- SceneDef ---------- */

// Inline SVG thumbnail (96x54): night sky, two dark building silhouettes with
// scattered warm lit-window dots and one red beacon dot.
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<defs>' +
      '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#060912"/>' +
      '<stop offset="1" stop-color="#101a2e"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect width="96" height="54" fill="url(#sky)"/>' +
      '<circle cx="12" cy="6" r="0.8" fill="#cfe0ff" opacity="0.7"/>' +
      '<circle cx="28" cy="10" r="0.8" fill="#cfe0ff" opacity="0.5"/>' +
      '<circle cx="45" cy="4" r="0.8" fill="#cfe0ff" opacity="0.6"/>' +
      '<circle cx="60" cy="8" r="0.8" fill="#cfe0ff" opacity="0.7"/>' +
      '<circle cx="75" cy="5" r="0.8" fill="#cfe0ff" opacity="0.5"/>' +
      '<circle cx="88" cy="9" r="0.8" fill="#cfe0ff" opacity="0.6"/>' +
      '<circle cx="20" cy="14" r="0.6" fill="#cfe0ff" opacity="0.4"/>' +
      '<circle cx="52" cy="16" r="0.6" fill="#cfe0ff" opacity="0.5"/>' +
      '<circle cx="82" cy="13" r="0.6" fill="#cfe0ff" opacity="0.4"/>' +
      '<rect x="0" y="30" width="20" height="24" fill="#0a101c"/>' +
      '<rect x="21" y="34" width="14" height="20" fill="#0a101c"/>' +
      '<rect x="36" y="28" width="18" height="26" fill="#0a101c"/>' +
      '<rect x="55" y="26" width="22" height="28" fill="#0a101c"/>' +
      '<rect x="78" y="32" width="18" height="22" fill="#0a101c"/>' +
      '<rect x="0" y="38" width="24" height="16" fill="#070b13"/>' +
      '<rect x="25" y="32" width="28" height="22" fill="#070b13"/>' +
      '<rect x="54" y="29" width="20" height="25" fill="#070b13"/>' +
      '<rect x="75" y="35" width="21" height="19" fill="#070b13"/>' +
      '<rect x="38" y="35" width="2" height="7" fill="#070b13"/>' +
      '<circle cx="39" cy="34" r="1.5" fill="rgba(255,90,90,0.9)"/>' +
      '<rect x="29" y="36" r="1" width="2.5" height="3" fill="rgba(255,201,126,0.85)"/>' +
      '<rect x="33" y="36" r="1" width="2.5" height="3" fill="rgba(255,201,126,0.85)"/>' +
      '<rect x="29" y="41" r="1" width="2.5" height="3" fill="rgba(158,196,255,0.60)"/>' +
      '<rect x="57" y="33" r="1" width="2.5" height="3" fill="rgba(255,201,126,0.85)"/>' +
      '<rect x="62" y="33" r="1" width="2.5" height="3" fill="rgba(255,201,126,0.85)"/>' +
      '<rect x="57" y="38" r="1" width="2.5" height="3" fill="rgba(255,201,126,0.85)"/>' +
      '<rect x="62" y="38" r="1" width="2.5" height="3" fill="rgba(158,196,255,0.60)"/>' +
      '<rect x="78" y="39" r="1" width="2.5" height="3" fill="rgba(255,201,126,0.85)"/>' +
      '</svg>'
  )

export const cityLights: SceneDef = {
  id: 'city-lights',
  label: 'City Lights',
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

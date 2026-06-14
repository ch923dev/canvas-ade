/**
 * Rainy Window -- a faithful port of the "rain" scene from the approved mock
 * `docs/canvas-backdrop/mocks/scene-concepts.html` (mulberry32 seed 29). Near-black
 * glass background with warm/teal/blue bokeh radial blobs (`lighter` composite),
 * a dark glass overlay, faint vertical rain streaks, and soft droplets that slide
 * down the pane in real time. The bokeh is static (fixed once from the RNG); the
 * streaks and droplets animate via absolute-time modulo so pause/resume is a clean
 * phase jump with no accumulated state.
 *
 * Perf contract: one canvas, buffer dpr clamped to 1.5, <=30fps via a 33ms gate.
 * The rAF loop fully stops on stop() and under reduced motion start() is a no-op;
 * renderStill() paints exactly one static frame (t = STILL_T = 9). All geometry is
 * expressed as fractions of W/H (mock authored at 560x315); radii and line widths
 * scale by k = H/315 so the composition matches the concept at 1080p.
 *
 * Sizing: a ResizeObserver on the canvas rebuilds the model at the new buffer size
 * (a reduced-motion still re-paints; the live loop repaints itself on the next
 * frame). jsdom-safe: a null 2D context or zero clientWidth falls back to 1920x1080
 * and never throws.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 29
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 9 // static "mid-rain" export phase (~9s looks good for droplet positions)
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mock-identical) so seed 29 reproduces the approved pixels. */
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

/** One colored bokeh blob behind the glass (static -- never moves). */
interface BokehBlob {
  x: number
  y: number
  r: number
  /** Index into BOKEH_COLS. */
  col: number
}

/** One faint vertical rain streak on the glass. */
interface Streak {
  /** Fractional x position (0..1 of W). */
  fx: number
  /** Length in pixels at the reference scale. */
  len: number
  /** Base y in raw canvas pixels; animated as (baseY + STREAK_SPEED * t) % H. */
  baseY: number
  alpha: number
}

/** One glass droplet with a highlight. */
interface Drop {
  /** Fixed x position in canvas pixels. */
  x: number
  /** Base y in canvas pixels; animated as (baseY + speed * t) % H. */
  baseY: number
  /** Radius in raw canvas pixels at the reference scale. */
  r: number
  /** Fall speed in pixels per second. */
  speed: number
  alpha: number
}

interface SceneModel {
  W: number
  H: number
  /** Scale factor: H / 315 -- all radii/lineWidths multiply by this. */
  k: number
  bokeh: BokehBlob[]
  streaks: Streak[]
  drops: Drop[]
}

/** The four bokeh colours from the mock (rgb strings). */
const BOKEH_COLS = ['255,179,107', '86,200,192', '90,140,255', '255,126,103'] as const

function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const k = H / 315

  // ~30 bokeh blobs behind the glass -- placed in the lower 60% like the mock
  const bokeh: BokehBlob[] = []
  for (let i = 0; i < 30; i++) {
    bokeh.push({
      x: rnd() * W,
      y: H * 0.35 + rnd() * H * 0.6,
      r: (16 + rnd() * 52) * k,
      col: (rnd() * BOKEH_COLS.length) | 0
    })
  }

  // ~46 faint vertical rain streaks
  const streaks: Streak[] = []
  for (let i = 0; i < 46; i++) {
    streaks.push({
      fx: rnd(),
      len: (24 + rnd() * 90) * k,
      baseY: rnd() * H,
      alpha: 0.04 + rnd() * 0.06
    })
  }

  // ~80 glass droplets with a brighter highlight offset
  const drops: Drop[] = []
  for (let i = 0; i < 80; i++) {
    drops.push({
      x: rnd() * W,
      baseY: rnd() * H,
      r: (1 + rnd() * 2.6) * k,
      // Droplets fall at 40..130 px/s (at 1080p scale) -- slow enough to feel viscous
      speed: (40 + rnd() * 90) * k,
      alpha: 0.5
    })
  }

  return { W, H, k, bokeh, streaks, drops }
}

/* ---------- painters ---------- */
type Ctx = CanvasRenderingContext2D

function renderScene(ctx: Ctx, t: number, model: SceneModel): void {
  const { W, H, k, bokeh, streaks, drops } = model

  // 1. Near-black background
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = '#090c12'
  ctx.fillRect(0, 0, W, H)

  // 2. Colored bokeh radial blobs -- additive "lighter" layer (bokeh is STATIC)
  ctx.globalCompositeOperation = 'lighter'
  for (const b of bokeh) {
    const c = BOKEH_COLS[b.col]
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r)
    g.addColorStop(0, 'rgba(' + c + ',.30)')
    g.addColorStop(0.7, 'rgba(' + c + ',.10)')
    g.addColorStop(1, 'rgba(' + c + ',0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(b.x, b.y, b.r, 0, TAU)
    ctx.fill()
  }

  // 3. Dark glass overlay -- dims the bokeh and adds the frosted-glass look
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = 'rgba(5,8,14,.38)'
  ctx.fillRect(0, 0, W, H)

  // 4. Faint vertical rain streaks -- drift downward over time
  // Streaks fall at a shared speed (~60 px/s at 315px reference height)
  const streakSpeed = 60 * k
  ctx.strokeStyle = '#cfe0ff'
  ctx.lineWidth = Math.max(1, k)
  for (const st of streaks) {
    const sx = st.fx * W
    const sy = (st.baseY + streakSpeed * t) % H
    ctx.globalAlpha = st.alpha
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(sx, sy + st.len)
    ctx.stroke()
  }

  // 5. Droplets -- each slides down at its own speed
  for (const d of drops) {
    const dy = (d.baseY + d.speed * t) % H
    // Soft drop body
    ctx.globalAlpha = d.alpha
    ctx.fillStyle = 'rgba(170,195,235,.30)'
    ctx.beginPath()
    ctx.arc(d.x, dy, d.r, 0, TAU)
    ctx.fill()
    // Brighter highlight offset up-left
    ctx.fillStyle = 'rgba(240,248,255,.55)'
    ctx.beginPath()
    ctx.arc(d.x - d.r * 0.3, dy - d.r * 0.3, d.r * 0.32, 0, TAU)
    ctx.fill()
  }

  // Reset to defaults so the next frame starts clean
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/* ---------- SceneDef ---------- */

// Inline SVG thumbnail: dark glass, a few soft colored bokeh circles, two droplet dots.
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<rect width="96" height="54" fill="#090c12"/>' +
      '<circle cx="22" cy="36" r="16" fill="rgba(255,179,107,0.22)"/>' +
      '<circle cx="54" cy="40" r="20" fill="rgba(86,200,192,0.18)"/>' +
      '<circle cx="78" cy="30" r="14" fill="rgba(90,140,255,0.22)"/>' +
      '<circle cx="38" cy="24" r="12" fill="rgba(255,126,103,0.18)"/>' +
      '<rect width="96" height="54" fill="rgba(5,8,14,0.38)"/>' +
      '<circle cx="28" cy="18" r="2.2" fill="rgba(170,195,235,0.5)"/>' +
      '<circle cx="26.8" cy="16.8" r="0.7" fill="rgba(240,248,255,0.7)"/>' +
      '<circle cx="65" cy="38" r="3" fill="rgba(170,195,235,0.5)"/>' +
      '<circle cx="63.7" cy="36.7" r="0.95" fill="rgba(240,248,255,0.7)"/>' +
      '</svg>'
  )

export const rainyWindow: SceneDef = {
  id: 'rainy-window',
  label: 'Rainy Window',
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

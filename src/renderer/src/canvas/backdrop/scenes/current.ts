/**
 * Current — the livelier ambient scene (PR 3a, S9). A faithful port of the approved
 * ambient mock `docs/canvas-backdrop/mocks/ambient-bg.html` (the CURRENT panel) at its
 * user-tuned numbers (density 150, trail 0.55, swirl 1.0, eddy 1.0, direction -8deg,
 * speed 24): drifting streamline comets flowing through a curl-ish field over the dot
 * lattice — "the river".
 *
 * Stateful, unlike Drift/Blossom: it integrates particle positions by `dt` and keeps a
 * persistent trail buffer (each frame erases a little void by alpha so streamlines fade
 * into comets). The model rebuilds deterministically from a fixed seed so the particle
 * layout is reproducible (testable); the flow field itself is pure sin() of position +
 * time. Resize re-inits the trail buffer (curInit) so a stale-size frame never lingers.
 *
 * Perf contract (docs/canvas-backdrop/addendum-presets.md §3): one canvas, buffer dpr
 * clamped to 1.5, <=30fps via a 33ms frame gate (~1ms/frame measured in the mock), full
 * rAF stop on stop(), start() a no-op under reduced motion (renderStill paints one quiet
 * streamline still). jsdom-safe: null 2D context / zero clientWidth ⇒ 1920x1080 buffer,
 * never throws.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 3 // particle-layout seed (flow field is seedless sin(); look is seed-stable)
const FRAME_MS = 33 // <=30fps gate
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const GRID_GAP = 24

/* ---------- tuned numbers (mock-identical) ---------- */
const BRIGHTNESS = 0.07 // peak stroke alpha
const SPEED = 24 // px/s particle drift
const DENSITY = 150 // particle count
const TRAIL = 0.55 // 0..1 → longer trail = slower erase
const SWIRL = 1.0 // eddy strength (rad amplitude)
const EDDY_SCALE = 1.0 // eddy size multiplier
const DIR = -8 // base flow direction, degrees
const FADE = 0.125 - TRAIL * 0.105 // void erased per frame (~0.067 at trail 0.55)

/** Deterministic RNG (mock-identical) so the particle layout reproduces. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Particle {
  x: number
  y: number
  life: number
  maxLife: number
}

/** Curl-ish flow field — angle of flow at CSS-space (x, y) and time t (seconds). */
function flowAngle(x: number, y: number, t: number): number {
  const f = 0.004 / EDDY_SCALE
  const n =
    (Math.sin(x * f + t * 0.21) +
      Math.sin(y * f * 1.31 - t * 0.16) +
      Math.sin((x * 0.62 + y * 0.84) * f * 0.71 + t * 0.11)) /
    3
  return (DIR * Math.PI) / 180 + n * SWIRL * 0.9
}

function spawn(rnd: () => number, w: number, h: number, fresh: boolean): Particle {
  const maxLife = 6 + rnd() * 8
  return { x: rnd() * w, y: rnd() * h, life: fresh ? rnd() * maxLife : 0, maxLife }
}

function drawGridOn(x: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
  const gap = GRID_GAP * dpr
  const r = Math.max(1, Math.round(0.5 * dpr)) * 2
  x.fillStyle = '#202022' // --grid-dot
  for (let y = gap / 2; y < h; y += gap)
    for (let px = gap / 2; px < w; px += gap) x.fillRect(px - r / 2, y - r / 2, r, r)
}

export const current: SceneDef = {
  id: 'current',
  label: 'Current',
  tier: 'ambient',
  thumb:
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
        '<rect width="96" height="54" fill="#0a0a0b"/>' +
        '<g fill="none" stroke="#e1e5ee" stroke-linecap="round">' +
        '<path d="M2 16 q24 -7 46 2 t46 1" stroke-width="1" opacity="0.5"/>' +
        '<path d="M0 30 q26 -9 50 1 t44 3" stroke-width="1.3" opacity="0.7"/>' +
        '<path d="M4 42 q22 -6 44 0 t46 2" stroke-width="1" opacity="0.4"/>' +
        '</g></svg>'
    ),
  create(canvas: HTMLCanvasElement, opts: SceneOpts): SceneHandle {
    const ctx = canvas.getContext('2d')
    const rnd = mulberry32(SEED)
    const parts: Particle[] = []
    let running = false
    let raf = 0
    let lastDraw = 0
    let sized = false
    let curInit = false // trail buffer painted with solid void yet?
    let ro: ResizeObserver | null = null

    const ensureSize = (): boolean => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CLAMP)
      const w = canvas.clientWidth > 0 ? Math.round(canvas.clientWidth * dpr) : FALLBACK_W
      const h = canvas.clientHeight > 0 ? Math.round(canvas.clientHeight * dpr) : FALLBACK_H
      if (sized && w === canvas.width && h === canvas.height) return false
      canvas.width = w
      canvas.height = h
      sized = true
      curInit = false // a resized buffer is blank — repaint solid void next frame
      return true
    }

    const syncParts = (w: number, h: number): void => {
      while (parts.length < DENSITY) parts.push(spawn(rnd, w, h, true))
      if (parts.length > DENSITY) parts.length = DENSITY
    }

    /** One live frame: integrate particles by dt, fade the trail, restamp the grid. */
    const drawLive = (dt: number, t: number): void => {
      if (ctx === null) return
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CLAMP)
      const w = canvas.width
      const h = canvas.height
      syncParts(w, h)
      if (!curInit) {
        ctx.fillStyle = 'rgb(10,10,11)' // --void
        ctx.fillRect(0, 0, w, h)
        curInit = true
      }
      ctx.fillStyle = `rgba(10,10,11,${FADE.toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
      drawGridOn(ctx, w, h, dpr)
      ctx.lineWidth = Math.max(1, dpr)
      ctx.lineCap = 'round'
      const v = SPEED * dpr
      for (const p of parts) {
        const a = flowAngle(p.x / dpr, p.y / dpr, t)
        const nx = p.x + Math.cos(a) * v * dt
        const ny = p.y + Math.sin(a) * v * dt
        p.life += dt
        const env = Math.sin(Math.PI * Math.min(p.life / p.maxLife, 1))
        ctx.strokeStyle = `rgba(225,229,238,${(BRIGHTNESS * env).toFixed(4)})`
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(nx, ny)
        ctx.stroke()
        p.x = nx
        p.y = ny
        const m = 24 * dpr
        if (p.life >= p.maxLife || nx < -m || nx > w + m || ny < -m || ny > h + m)
          Object.assign(p, spawn(rnd, w, h, false))
      }
    }

    /** Reduced-motion still: one quiet frame of faint short streaks along the field. */
    const drawStill = (): void => {
      if (ctx === null) return
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CLAMP)
      const w = canvas.width
      const h = canvas.height
      ctx.fillStyle = 'rgb(10,10,11)'
      ctx.fillRect(0, 0, w, h)
      drawGridOn(ctx, w, h, dpr)
      syncParts(w, h)
      ctx.lineWidth = Math.max(1, dpr)
      ctx.lineCap = 'round'
      for (const p of parts) {
        const env = Math.sin(Math.PI * ((p.life % p.maxLife) / p.maxLife))
        ctx.strokeStyle = `rgba(225,229,238,${(BRIGHTNESS * 0.8 * env).toFixed(4)})`
        let x = p.x
        let y = p.y
        ctx.beginPath()
        ctx.moveTo(x, y)
        for (let i = 0; i < 12; i++) {
          const a = flowAngle(x / dpr, y / dpr, 0)
          x += Math.cos(a) * 1.6 * dpr
          y += Math.sin(a) * 1.6 * dpr
          ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }

    const observe = (): void => {
      if (ro !== null || typeof ResizeObserver === 'undefined') return
      ro = new ResizeObserver(() => {
        if (ensureSize() && !running) drawStill()
      })
      ro.observe(canvas)
    }

    const tick = (now: number): void => {
      if (!running) return
      if (lastDraw === 0 || now - lastDraw >= FRAME_MS) {
        const dt = lastDraw === 0 ? FRAME_MS / 1000 : Math.min((now - lastDraw) / 1000, 0.05)
        lastDraw = now
        ensureSize()
        drawLive(dt, now / 1000)
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
        drawStill()
      }
    }
  }
}

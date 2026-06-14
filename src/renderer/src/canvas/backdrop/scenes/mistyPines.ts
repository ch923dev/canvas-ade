/**
 * Misty Pines - the richest bundled scene (PR 3b). A faithful port of the approved
 * mock `docs/canvas-backdrop/mocks/scene-misty-pines.html` (mulberry32 seed 13,
 * pixels signed off 2026-06-13). Layered pine ridges fade into a warm hazy sun;
 * fog banks sway between the ridges, light rays pulse over the valley, two bird
 * flocks cross, and dust motes drift near the sun.
 *
 * ALL motion is periodic over LOOP_T = 120s (every frequency is an integer harmonic
 * of LOOP_W, each bird crossing is exactly one span per loop), exactly as authored -
 * that periodicity is how the user's interim WebM wallpaper looped seamlessly. Render
 * is a pure function of (model, t): buildScene consumes the RNG once to fix the
 * composition (reproducible at any buffer size; resize never drifts the look), and
 * pause/resume is just a phase jump.
 *
 * Perf contract (docs/canvas-backdrop/addendum-presets.md section 3): one canvas,
 * buffer dpr clamped to 1.5, <=30fps via a 33ms frame gate. The rAF loop FULLY stops
 * on stop() (the layer calls it on unmount / document.hidden); under reduced motion
 * start() is a no-op and renderStill() paints exactly one frame (the mock's t=24.6
 * fog/ray phase). jsdom-safe: a null 2D context or zero clientWidth falls back to a
 * 1920x1080 buffer and never throws.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 13
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 24.6 // the mock's pleasant fog/ray export phase
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2
const LOOP_T = 120 // seconds; all motion is an integer harmonic of this
const LOOP_W = TAU / LOOP_T

/** Deterministic RNG (mock-identical) so seed 13 reproduces the approved pixels. */
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
const P = {
  skyTop: '#27444f',
  skyMid: '#5d8490',
  skyLow: '#c4d6d0',
  skyHorizon: '#f0debc',
  sunCore: 'rgba(255,242,214,0.95)',
  sunGlow: '255,222,168',
  ray: '255,228,180',
  fog: '230,240,242',
  ridge: ['#b9cdd1', '#a2bac0', '#82a0a8', '#5f828c', '#3f5f6a', '#26404a'],
  tree: ['#adc3c8', '#95aeb5', '#75949d', '#52757f', '#345460', '#1f3741'],
  bird: 'rgba(38,54,60,0.85)',
  mote: '255,238,205'
} as const

/* ---------- scene model (built once per seed/size) ---------- */
interface RidgeDef {
  y0: number
  amp: number
  th: number
  gap: number
}
const RIDGE: readonly RidgeDef[] = [
  { y0: 0.565, amp: 0.018, th: 0.012, gap: 24 },
  { y0: 0.605, amp: 0.024, th: 0.016, gap: 28 },
  { y0: 0.655, amp: 0.034, th: 0.024, gap: 34 },
  { y0: 0.72, amp: 0.044, th: 0.042, gap: 46 },
  { y0: 0.81, amp: 0.054, th: 0.08, gap: 66 },
  { y0: 0.935, amp: 0.045, th: 0.155, gap: 96 }
]

interface Tree {
  x: number
  y: number
  h: number
}
interface Ridge {
  pts: number[]
  trees: Tree[]
  col: string
  treeCol: string
}
interface FogBlob {
  u: number
  rx: number
  amp: number
  k: number
  ph: number
}
interface Fog {
  y: number
  h: number
  alpha: number
  blobs: FogBlob[]
}
interface Member {
  dx: number
  dy: number
  ph: number
}
interface Flock {
  y: number
  dir: number
  speed: number
  off: number
  members: Member[]
}
interface Mote {
  x: number
  y: number
  r: number
  amp: number
  k: number
  ph: number
  a: number
}
interface SceneModel {
  W: number
  H: number
  sun: { x: number; y: number }
  ridges: Ridge[]
  fogs: Fog[]
  flocks: Flock[]
  motes: Mote[]
}

function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const sun = { x: W * 0.64, y: H * 0.555 }
  // ridges: polyline (sum of sines) + pines planted along it
  const ridges: Ridge[] = RIDGE.map((d, i) => {
    const f1 = 1.2 + rnd() * 1.4
    const f2 = 2.6 + rnd() * 2.2
    const f3 = 5 + rnd() * 4
    const p1 = rnd() * 7
    const p2 = rnd() * 7
    const p3 = rnd() * 7
    const pts: number[] = []
    for (let px = 0; px <= W + 8; px += 8) {
      const u = px / W
      pts.push(
        d.y0 * H +
          d.amp *
            H *
            (0.55 * Math.sin(TAU * f1 * u + p1) +
              0.3 * Math.sin(TAU * f2 * u + p2) +
              0.15 * Math.sin(TAU * f3 * u + p3))
      )
    }
    const yAt = (px: number): number => {
      const k = Math.max(0, Math.min(pts.length - 2, Math.floor(px / 8)))
      const f = px / 8 - k
      return pts[k] * (1 - f) + pts[k + 1] * f
    }
    const trees: Tree[] = []
    let tx = -20 + rnd() * d.gap
    while (tx < W + 30) {
      const h = d.th * H * (0.5 + rnd() * 1.0)
      trees.push({ x: tx, y: yAt(tx) + h * 0.06, h })
      // clumped spacing: occasional clearings break the uniform comb silhouette
      tx += d.gap * (0.5 + rnd() * 0.9) + (rnd() < 0.18 ? d.gap * (1.5 + rnd() * 2.5) : 0)
    }
    return { pts, trees, col: P.ridge[i], treeCol: P.tree[i] }
  })
  // fog banks: one between each ridge pair + a deep valley layer in front. Blobs
  // sway sinusoidally (loop-periodic) instead of streaming linearly.
  const fogs: Fog[] = []
  for (let i = 0; i < RIDGE.length; i++) {
    const yNext = i < RIDGE.length - 1 ? RIDGE[i + 1].y0 : 1.04
    const blobs: FogBlob[] = []
    for (let b = 0; b < 5; b++) {
      blobs.push({
        u: rnd(),
        rx: W * (0.15 + rnd() * 0.15),
        amp: W * (0.03 + rnd() * 0.05), // sway reach ~60-150px at 1080p
        k: 1 + Math.floor(rnd() * 2), // 1-2 sways per loop (60-120s period)
        ph: rnd() * 7
      })
    }
    fogs.push({
      y: ((RIDGE[i].y0 + yNext) / 2 + 0.012) * H,
      h: H * (0.024 + i * 0.008),
      alpha: 0.2 + i * 0.03,
      blobs
    })
  }
  // bird flocks (loose V formations, long slow crossings)
  const flocks: Flock[] = []
  for (let i = 0; i < 2; i++) {
    const dir = i % 2 ? -1 : 1
    const members: Member[] = []
    const n = 5 + Math.floor(rnd() * 3)
    for (let k = 0; k < n; k++) {
      const side = k % 2 ? 1 : -1
      const rank = Math.ceil(k / 2)
      members.push({
        dx: -dir * rank * (24 + rnd() * 8),
        dy: rank * side * (9 + rnd() * 5),
        ph: rnd() * 7
      })
    }
    // exactly one full span per loop -> the crossing wraps seamlessly (~27px/s at 1080p)
    flocks.push({
      y: H * (0.2 + rnd() * 0.14),
      dir,
      speed: (W * 1.7) / LOOP_T,
      off: rnd() * W * 1.7,
      members
    })
  }
  // dust motes, brighter near the sun; drift is a slow loop-periodic wander
  const motes: Mote[] = []
  for (let i = 0; i < 46; i++) {
    const mx = rnd() * W
    const my = H * (0.28 + rnd() * 0.48)
    const dist = Math.hypot(mx - sun.x, my - sun.y)
    motes.push({
      x: mx,
      y: my,
      r: 0.8 + rnd() * 1.5,
      amp: W * (0.015 + rnd() * 0.02),
      k: 2 + Math.floor(rnd() * 3),
      ph: rnd() * 7,
      a: 0.3 * Math.max(0.15, 1 - dist / (W * 0.55))
    })
  }
  return { W, H, sun, ridges, fogs, flocks, motes }
}

/* ---------- painters (mock-identical) ---------- */
type Ctx = CanvasRenderingContext2D

function paintSky(x: Ctx, S: SceneModel): void {
  const g = x.createLinearGradient(0, 0, 0, S.H * 0.62)
  g.addColorStop(0, P.skyTop)
  g.addColorStop(0.55, P.skyMid)
  g.addColorStop(0.86, P.skyLow)
  g.addColorStop(1, P.skyHorizon)
  x.fillStyle = g
  x.fillRect(0, 0, S.W, S.H * 0.62)
}

function paintSunGlow(x: Ctx, S: SceneModel, strength: number): void {
  const { sun, W } = S
  const g = x.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, W * 0.32)
  g.addColorStop(0, 'rgba(' + P.sunGlow + ',' + 0.55 * strength + ')')
  g.addColorStop(0.4, 'rgba(' + P.sunGlow + ',' + 0.18 * strength + ')')
  g.addColorStop(1, 'rgba(' + P.sunGlow + ',0)')
  x.fillStyle = g
  x.fillRect(sun.x - W * 0.32, sun.y - W * 0.32, W * 0.64, W * 0.64)
  if (strength > 0.9) {
    x.fillStyle = P.sunCore
    x.beginPath()
    x.arc(sun.x, sun.y, W * 0.016, 0, TAU)
    x.fill()
  }
}

function paintPine(x: Ctx, px: number, py: number, h: number, col: string): void {
  x.fillStyle = col
  if (h < 18) {
    // far ridges: simple spike
    x.beginPath()
    x.moveTo(px - h * 0.32, py)
    x.lineTo(px, py - h)
    x.lineTo(px + h * 0.32, py)
    x.closePath()
    x.fill()
    return
  }
  if (h > 60) x.fillRect(px - h * 0.018, py - h * 0.06, h * 0.036, h * 0.12)
  const tiers = h > 60 ? 4 : 2
  for (let i = 0; i < tiers; i++) {
    const base = py - i * h * 0.21
    const hw = h * 0.21 * (1 - i / (tiers + 0.8))
    x.beginPath()
    x.moveTo(px - hw, base)
    x.lineTo(px, base - h * 0.42)
    x.lineTo(px + hw, base)
    x.closePath()
    x.fill()
  }
}

function paintRidge(x: Ctx, S: SceneModel, r: Ridge): void {
  const { W, H } = S
  x.fillStyle = r.col
  x.beginPath()
  x.moveTo(0, r.pts[0])
  for (let k = 1; k < r.pts.length; k++) x.lineTo(k * 8, r.pts[k])
  x.lineTo(W, H)
  x.lineTo(0, H)
  x.closePath()
  x.fill()
  for (const t of r.trees) paintPine(x, t.x, t.y, t.h, r.treeCol)
}

function paintFog(x: Ctx, S: SceneModel, f: Fog, t: number): void {
  const { W } = S
  const g = x.createLinearGradient(0, f.y - f.h, 0, f.y + f.h)
  g.addColorStop(0, 'rgba(' + P.fog + ',0)')
  g.addColorStop(0.5, 'rgba(' + P.fog + ',' + (f.alpha * 0.5).toFixed(3) + ')')
  g.addColorStop(1, 'rgba(' + P.fog + ',0)')
  x.fillStyle = g
  x.fillRect(0, f.y - f.h, W, f.h * 2)
  for (const b of f.blobs) {
    const span = W + 2 * b.rx
    // no modulo wrap: the sway is bounded, and a blob sliding partly offscreen just
    // clips (the linear band underlay keeps full-width coverage)
    const bx = b.u * span - b.rx + b.amp * Math.sin(LOOP_W * b.k * t + b.ph)
    const g2 = x.createRadialGradient(bx, f.y, 0, bx, f.y, b.rx)
    g2.addColorStop(0, 'rgba(' + P.fog + ',' + f.alpha.toFixed(3) + ')')
    g2.addColorStop(1, 'rgba(' + P.fog + ',0)')
    x.save()
    x.translate(bx, f.y)
    x.scale(1, (f.h * 1.4) / b.rx)
    x.translate(-bx, -f.y)
    x.fillStyle = g2
    x.fillRect(bx - b.rx, f.y - b.rx, b.rx * 2, b.rx * 2)
    x.restore()
  }
}

function paintRays(x: Ctx, S: SceneModel, t: number): void {
  const { sun, W } = S
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * (0.76 + i * 0.036) + 0.012 * Math.sin(LOOP_W * t + i * 1.7)
    const alpha = Math.max(0, 0.045 + 0.03 * Math.sin(LOOP_W * 2 * t + i * 1.3))
    if (alpha < 0.01) continue
    const L = W * 0.78
    const hw = 0.01 + (i % 3) * 0.006
    const ex = sun.x + Math.cos(a) * L
    const ey = sun.y + Math.sin(a) * L
    const g = x.createLinearGradient(sun.x, sun.y, ex, ey)
    g.addColorStop(0, 'rgba(' + P.ray + ',' + alpha.toFixed(3) + ')')
    g.addColorStop(1, 'rgba(' + P.ray + ',0)')
    x.fillStyle = g
    x.beginPath()
    x.moveTo(sun.x, sun.y)
    x.lineTo(sun.x + Math.cos(a - hw) * L, sun.y + Math.sin(a - hw) * L)
    x.lineTo(sun.x + Math.cos(a + hw) * L, sun.y + Math.sin(a + hw) * L)
    x.closePath()
    x.fill()
  }
}

function paintBirds(x: Ctx, S: SceneModel, t: number): void {
  const { W } = S
  x.strokeStyle = P.bird
  x.lineWidth = Math.max(1.4, S.H / 620)
  x.lineCap = 'round'
  for (const fl of S.flocks) {
    const span = W * 1.7
    let head = (t * fl.speed * fl.dir + fl.off) % span
    if (head < 0) head += span
    head -= W * 0.35
    for (const m of fl.members) {
      // bob/flap at harmonics 13 and 31 of the loop base (~0.68 / ~1.62 rad/s,
      // matching the original 0.7 / 1.6 tuning)
      const mx = head + m.dx
      const my = fl.y + m.dy + Math.sin(LOOP_W * 13 * t + m.ph) * 4
      if (mx < -30 || mx > W + 30) continue
      const flap = 3.5 + 2.5 * Math.sin(LOOP_W * 31 * t + m.ph)
      const s = 7
      x.beginPath()
      x.moveTo(mx - s, my - flap * 0.55)
      x.quadraticCurveTo(mx - s * 0.4, my + 1, mx, my)
      x.quadraticCurveTo(mx + s * 0.4, my + 1, mx + s, my - flap * 0.55)
      x.stroke()
    }
  }
}

function paintMotes(x: Ctx, S: SceneModel, t: number): void {
  for (const m of S.motes) {
    // wander/bob/twinkle at harmonics k, 8, 17 (~0.42 / ~0.89 rad/s vs the original
    // 0.4 / 0.9 tuning)
    const xx = m.x + m.amp * Math.sin(LOOP_W * m.k * t + m.ph)
    const yy = m.y + Math.sin(LOOP_W * 8 * t + m.ph) * 9
    const a = m.a * (0.5 + 0.5 * Math.sin(LOOP_W * 17 * t + m.ph * 2))
    if (a < 0.02) continue
    x.fillStyle = 'rgba(' + P.mote + ',' + a.toFixed(3) + ')'
    x.beginPath()
    x.arc(xx, yy, m.r, 0, TAU)
    x.fill()
  }
}

function paintVignette(x: Ctx, S: SceneModel): void {
  const { W, H } = S
  const g = x.createRadialGradient(W / 2, H * 0.52, H * 0.42, W / 2, H * 0.52, H * 1.05)
  g.addColorStop(0, 'rgba(12,22,27,0)')
  g.addColorStop(1, 'rgba(12,22,27,0.26)')
  x.fillStyle = g
  x.fillRect(0, 0, W, H)
}

/* ---------- compose (mock-identical order) ---------- */
function renderScene(x: Ctx, t: number, S: SceneModel): void {
  paintSky(x, S)
  paintSunGlow(x, S, 1)
  for (let i = 0; i < S.ridges.length; i++) {
    paintRidge(x, S, S.ridges[i])
    if (i === 1) paintSunGlow(x, S, 0.3) // atmospheric re-glow over the far ridges
    paintFog(x, S, S.fogs[i], t)
    if (i === 3) paintRays(x, S, t) // rays wash the valley, foreground stays crisp
  }
  paintBirds(x, S, t)
  paintMotes(x, S, t)
  paintVignette(x, S)
}

/* ---------- thumbnail (gallery picker) ---------- */
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#27444f"/><stop offset="0.6" stop-color="#5d8490"/>' +
      '<stop offset="1" stop-color="#f0debc"/></linearGradient>' +
      '<radialGradient id="g" cx="64%" cy="64%" r="40%">' +
      '<stop offset="0" stop-color="#ffe8b8"/><stop offset="1" stop-color="#ffe8b800"/>' +
      '</radialGradient></defs>' +
      '<rect width="96" height="54" fill="url(#s)"/>' +
      '<rect width="96" height="54" fill="url(#g)"/>' +
      '<path d="M0 34 L20 30 L42 35 L66 31 L96 36 L96 54 L0 54 Z" fill="#5f828c"/>' +
      '<path d="M0 42 L26 38 L52 43 L78 39 L96 43 L96 54 L0 54 Z" fill="#345460"/>' +
      '<path d="M0 49 L30 45 L60 50 L96 46 L96 54 L0 54 Z" fill="#1f3741"/>' +
      '</svg>'
  )

export const mistyPines: SceneDef = {
  id: 'misty-pines',
  label: 'Misty Pines',
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

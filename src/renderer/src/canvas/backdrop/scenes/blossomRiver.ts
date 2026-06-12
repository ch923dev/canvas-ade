/**
 * Blossom River — the first bundled backdrop scene (PR 2, S6/S7). A faithful port of
 * the approved mock `docs/canvas-backdrop/mocks/scene-blossom-river.html` at its
 * signed-off composition (mulberry32 seed 7); the model rebuilds deterministically
 * from that seed at any buffer size, so resize never drifts the look.
 *
 * Perf contract (docs/canvas-backdrop/addendum-presets.md §3): one canvas, buffer dpr
 * clamped to 1.5, <=30fps via a 33ms frame gate, target ~2ms/frame at 1080p. The rAF
 * loop FULLY stops on stop() — the layer calls it on unmount and document.hidden —
 * and under reduced motion start() is a no-op; renderStill() paints exactly one
 * frame (the mock's t=38.2 export phase). All motion is absolute-time driven, so a
 * pause/resume just jumps phase (no accumulated state to corrupt).
 *
 * Sizing: the handle owns a ResizeObserver on its canvas — connected by
 * start()/renderStill(), disconnected by stop() — rebuilding the model at the new
 * buffer size (a reduced-motion still re-paints; the live loop repaints itself on
 * the next frame). jsdom-safe: a null 2D context or zero clientWidth falls back to
 * a 1920x1080 buffer and never throws.
 */
import type { SceneDef, SceneHandle, SceneOpts } from '../sceneRegistry'

const SEED = 7
const FRAME_MS = 33 // <=30fps gate
const STILL_T = 38.2 // the mock's "pleasant shimmer phase" export still
const DPR_CLAMP = 1.5
const FALLBACK_W = 1920
const FALLBACK_H = 1080
const TAU = Math.PI * 2

/** Deterministic RNG (mock-identical) so seed 7 reproduces the approved pixels. */
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
  skyTop: '#3f9fe6',
  skyMid: '#7cc4f0',
  skyHorizon: '#d9effb',
  cloud: '#ffffff',
  cloudShade: '#cfe4f2',
  mtn: '#b7cdde',
  snow: '#f1f8fd',
  grassFar: '#dca35e',
  grassMid: '#cf8d44',
  grassNear: '#c17a33',
  grassLight: '#ecbf76',
  grassDark: '#a96526',
  riverFar: '#bfe2f2',
  riverMid: '#3a7cc4',
  riverNear: '#225a9e',
  riverDeep: '#1b4a85',
  bankEdge: 'rgba(120,80,35,0.55)',
  trunk: '#6b4434',
  canopy: ['#c75b85', '#d96b92', '#e687ab', '#f3aac6'],
  canopyHi: '#fbd2e2'
} as const

/* ---------- scene model (built once per seed/size) ---------- */
interface Cloud {
  x: number
  y: number
  s: number
  v: number
}
interface CanopyBlob {
  dx: number
  dy: number
  r: number
  c: number
}
interface Tree {
  x: number
  y: number
  s: number
  blobs: CanopyBlob[]
}
interface FarTree {
  x: number
  y: number
  s: number
}
interface Tuft {
  x: number
  y: number
  s: number
  kind: number
}
interface Petal {
  x: number
  y: number
  s: number
  vy: number
  ph: number
  sway: number
  rot: number
}
interface SceneModel {
  W: number
  H: number
  horizon: number
  riverTop: number
  xl: number[]
  xr: number[]
  clouds: Cloud[]
  trees: Tree[]
  farTrees: FarTree[]
  tufts: Tuft[]
  petals: Petal[]
}

function makeCanopy(rnd: () => number): CanopyBlob[] {
  const blobs: CanopyBlob[] = []
  for (let i = 0; i < 90; i++) {
    const a = rnd() * TAU,
      d = Math.pow(rnd(), 0.55)
    blobs.push({
      dx: Math.cos(a) * d,
      dy: Math.sin(a) * d * 0.78,
      r: 0.045 + rnd() * 0.085,
      c: rnd()
    })
  }
  return blobs
}

function buildScene(W: number, H: number, rnd: () => number): SceneModel {
  const horizon = H * 0.5,
    riverTop = H * 0.52
  // river banks per scanline
  const xl: number[] = [],
    xr: number[] = []
  for (let y = 0; y < H; y++) {
    if (y < riverTop) {
      xl[y] = -1
      xr[y] = -1
      continue
    }
    const u = (y - riverTop) / (H - riverTop)
    const cx = W * (0.52 + 0.1 * Math.sin(u * 3.0 - 0.4) * (1 - u * 0.5) - 0.05 * u)
    const hw = W * (0.012 + 0.3 * Math.pow(u, 1.55))
    xl[y] = cx - hw
    xr[y] = cx + hw
  }
  // clouds: x, y, scale, speed
  const clouds: Cloud[] = []
  for (let i = 0; i < 7; i++) {
    clouds.push({
      x: rnd() * W * 1.2 - W * 0.1,
      y: H * (0.06 + rnd() * 0.3),
      s: W * (0.05 + rnd() * 0.075),
      v: 2.5 + rnd() * 4
    })
  }
  // mid/foreground blossom trees on the banks (x frac, base y frac, scale frac of H)
  const trees: Tree[] = [
    { x: 0.16, y: 0.615, s: 0.34 },
    { x: 0.33, y: 0.565, s: 0.22 },
    { x: 0.63, y: 0.575, s: 0.24 },
    { x: 0.79, y: 0.635, s: 0.38 },
    { x: 0.91, y: 0.56, s: 0.2 },
    { x: 0.035, y: 0.86, s: 0.62 }, // foreground framing, left
    { x: 0.975, y: 0.92, s: 0.7 } // foreground framing, right
  ].map((t) => ({ x: t.x * W, y: t.y * H, s: t.s * H, blobs: makeCanopy(rnd) }))
  // distant pink treeline dots
  const farTrees: FarTree[] = []
  for (let i = 0; i < 26; i++) {
    const fx = rnd() * W
    farTrees.push({ x: fx, y: horizon - 2 - rnd() * 8, s: 7 + rnd() * 14 })
  }
  // grass tufts + flowers
  const tufts: Tuft[] = []
  for (let i = 0; i < 420; i++) {
    const y = riverTop + Math.pow(rnd(), 0.7) * (H - riverTop) * 0.98
    const side = rnd() < 0.5
    const margin = 8 + rnd() * (W * 0.05)
    const yi = Math.floor(y)
    const x = side
      ? rnd() * Math.max(0, xl[yi] - margin)
      : Math.min(W, xr[yi] + margin) + rnd() * Math.max(0, W - xr[yi] - margin)
    if (!Number.isFinite(x)) continue
    tufts.push({ x, y, s: 2 + (y / H) * 9 * rnd(), kind: rnd() })
  }
  // petals
  const petals: Petal[] = []
  for (let i = 0; i < 70; i++) {
    petals.push({
      x: rnd() * W,
      y: rnd() * H,
      s: 2 + rnd() * 3.5,
      vy: 12 + rnd() * 22,
      ph: rnd() * TAU,
      sway: 10 + rnd() * 26,
      rot: rnd() * Math.PI
    })
  }
  return { W, H, horizon, riverTop, xl, xr, clouds, trees, farTrees, tufts, petals }
}

/* ---------- painters (mock-identical pipeline) ---------- */
type Ctx = CanvasRenderingContext2D

function paintSky(x: Ctx, S: SceneModel): void {
  const g = x.createLinearGradient(0, 0, 0, S.horizon * 1.04)
  g.addColorStop(0, P.skyTop)
  g.addColorStop(0.62, P.skyMid)
  g.addColorStop(1, P.skyHorizon)
  x.fillStyle = g
  x.fillRect(0, 0, S.W, S.horizon * 1.05)
}

const CLOUD_PUFFS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0.52],
  [0.5, 0.1, 0.4],
  [-0.5, 0.12, 0.38],
  [0.2, -0.24, 0.36],
  [-0.22, -0.2, 0.3],
  [0.02, 0.16, 0.46]
]
function paintCloud(x: Ctx, cx: number, cy: number, s: number): void {
  x.fillStyle = P.cloudShade
  for (const [px, py, pr] of CLOUD_PUFFS) {
    x.beginPath()
    x.arc(cx + px * s, cy + (py + 0.1) * s, pr * s, 0, TAU)
    x.fill()
  }
  x.fillStyle = P.cloud
  for (const [px, py, pr] of CLOUD_PUFFS) {
    x.beginPath()
    x.arc(cx + px * s, cy + (py - 0.04) * s, pr * s, 0, TAU)
    x.fill()
  }
}

function paintMountains(x: Ctx, S: SceneModel): void {
  const { W, horizon } = S
  x.fillStyle = P.mtn
  x.beginPath()
  x.moveTo(0, horizon)
  const pts: ReadonlyArray<readonly [number, number]> = [
    [0, 0.88],
    [0.08, 0.78],
    [0.16, 0.86],
    [0.24, 0.8],
    [0.5, 0.92],
    [0.62, 0.84],
    [0.72, 0.9],
    [0.84, 0.79],
    [0.93, 0.87],
    [1, 0.83]
  ]
  for (const [fx, fy] of pts) x.lineTo(fx * W, horizon * fy)
  x.lineTo(W, horizon)
  x.closePath()
  x.fill()
  // snow caps on the two tallest
  x.fillStyle = P.snow
  for (const [fx, fy] of [
    [0.08, 0.78],
    [0.84, 0.79]
  ] as const) {
    x.beginPath()
    x.moveTo(fx * W - W * 0.02, horizon * (fy + 0.045))
    x.lineTo(fx * W, horizon * fy)
    x.lineTo(fx * W + W * 0.02, horizon * (fy + 0.045))
    x.quadraticCurveTo(fx * W, horizon * (fy + 0.07), fx * W - W * 0.02, horizon * (fy + 0.045))
    x.fill()
  }
  // haze where mountains meet land
  x.fillStyle = 'rgba(217,239,251,0.5)'
  x.fillRect(0, horizon * 0.94, W, horizon * 0.07)
}

function paintLand(x: Ctx, S: SceneModel): void {
  const { W, H, horizon } = S
  const g = x.createLinearGradient(0, horizon, 0, H)
  g.addColorStop(0, P.grassFar)
  g.addColorStop(0.45, P.grassMid)
  g.addColorStop(1, P.grassNear)
  x.fillStyle = g
  x.fillRect(0, horizon, W, H - horizon)
  // soft rolling shading bands
  const bands: ReadonlyArray<readonly [number, number, number, number, number, string]> = [
    [0.22, 0.28, 0.26, 0.1, -0.08, 'rgba(255,231,170,0.20)'],
    [0.8, 0.36, 0.24, 0.12, 0.06, 'rgba(255,231,170,0.18)'],
    [0.1, 0.62, 0.22, 0.13, -0.05, 'rgba(255,220,150,0.13)'],
    [0.92, 0.72, 0.2, 0.15, 0.04, 'rgba(255,220,150,0.12)'],
    [0.55, 0.16, 0.3, 0.07, 0.03, 'rgba(120,70,25,0.13)'],
    [0.3, 0.46, 0.24, 0.09, 0.05, 'rgba(120,70,25,0.10)'],
    [0.72, 0.55, 0.26, 0.1, -0.04, 'rgba(120,70,25,0.09)']
  ]
  for (const [fx, fy, rx, ry, rot, col] of bands) {
    x.fillStyle = col
    x.beginPath()
    x.ellipse(W * fx, horizon + (H - horizon) * fy, W * rx, (H - horizon) * ry, rot, 0, TAU)
    x.fill()
  }
  // fine grass texture striping (short horizontal grain, denser near bottom)
  for (let i = 0; i < 240; i++) {
    const u = Math.pow((i * 0.618034) % 1, 0.8)
    const yy = horizon + u * (H - horizon) * 0.985
    const xx = (i * 379.7) % W
    x.strokeStyle = i % 3 === 0 ? 'rgba(255,225,160,0.12)' : 'rgba(120,70,25,0.10)'
    x.lineWidth = 1 + u * 1.6
    x.beginPath()
    x.moveTo(xx, yy)
    x.lineTo(xx + 14 + u * 46, yy)
    x.stroke()
  }
}

function riverPathTrace(x: Ctx, S: SceneModel): void {
  const { riverTop, H, xl, xr } = S
  x.beginPath()
  x.moveTo(xl[Math.floor(riverTop)], riverTop)
  for (let y = Math.floor(riverTop); y < H; y += 3) x.lineTo(xl[y], y)
  x.lineTo(xl[H - 1], H)
  x.lineTo(xr[H - 1], H)
  for (let y = H - 1; y >= riverTop; y -= 3) x.lineTo(xr[y], y)
  x.closePath()
}

function paintRiver(x: Ctx, S: SceneModel): void {
  const { riverTop, H } = S
  riverPathTrace(x, S)
  const g = x.createLinearGradient(0, riverTop, 0, H)
  g.addColorStop(0, P.riverFar)
  g.addColorStop(0.22, P.riverMid)
  g.addColorStop(0.7, P.riverNear)
  g.addColorStop(1, P.riverDeep)
  x.fillStyle = g
  x.fill()
  // bank edge
  x.strokeStyle = P.bankEdge
  x.lineWidth = Math.max(1.5, S.H / 480)
  riverPathTrace(x, S)
  x.stroke()
}

function paintReflections(x: Ctx, S: SceneModel): void {
  // soft pink + warm smears inside the river under the bank trees
  const { xl, xr, riverTop, H } = S
  x.save()
  riverPathTrace(x, S)
  x.clip()
  for (const t of S.trees) {
    if (t.y > H * 0.8) continue // skip foreground framing trees
    const y0 = Math.max(riverTop + 4, t.y + 6)
    const len = t.s * 0.9
    for (let i = 0; i < 26; i++) {
      const yy = y0 + (i / 26) * len
      if (yy >= H) break
      const row = Math.floor(yy)
      const cx = Math.min(Math.max(t.x, xl[row] + 8), xr[row] - 8)
      const ww = t.s * 0.34 * (1 - i / 30)
      x.strokeStyle = `rgba(231,135,171,${(0.1 * (1 - i / 26)).toFixed(3)})`
      x.lineWidth = 2 + (i % 3)
      x.beginPath()
      x.moveTo(cx - ww / 2, yy)
      x.lineTo(cx + ww / 2, yy)
      x.stroke()
    }
  }
  // sky reflection streak near the far bend
  x.fillStyle = 'rgba(235,248,255,0.25)'
  for (let y = Math.floor(riverTop); y < riverTop + (H - riverTop) * 0.12; y += 2) {
    x.fillRect(xl[y], y, xr[y] - xl[y], 1)
  }
  x.restore()
}

function paintShimmer(x: Ctx, S: SceneModel, t: number): void {
  const { xl, xr, riverTop, H } = S
  x.save()
  riverPathTrace(x, S)
  x.clip()
  for (let i = 0; i < 130; i++) {
    const u = (i * 0.61803 + 0.13) % 1
    const yy = Math.floor(riverTop + u * (H - riverTop - 2))
    const span = xr[yy] - xl[yy]
    if (span < 10) continue
    const drift = (t * (6 + (i % 7) * 3)) % (span * 1.4)
    const xx = xl[yy] + ((((i * 197) % span) + drift) % span)
    const a = 0.04 + 0.05 * Math.sin(t * 1.1 + i * 1.7) + (u < 0.25 ? 0.05 : 0)
    if (a <= 0.015) continue
    x.strokeStyle = `rgba(225,242,252,${Math.max(0.015, a).toFixed(3)})`
    x.lineWidth = 1 + (i % 2)
    const len = 8 + (i % 5) * 9 + u * 26
    x.beginPath()
    x.moveTo(xx, yy)
    x.lineTo(xx + len, yy)
    x.stroke()
  }
  // floating petal patches
  for (let i = 0; i < 28; i++) {
    const u = (i * 0.381966 + 0.4) % 1
    const yy = Math.floor(riverTop + u * (H - riverTop - 2))
    const span = xr[yy] - xl[yy]
    if (span < 12) continue
    const xx = xl[yy] + ((i * 311 + t * (3 + (i % 4)) * 4) % span)
    x.fillStyle = `rgba(244,168,196,${(0.25 + 0.1 * Math.sin(t + i)).toFixed(2)})`
    x.beginPath()
    x.ellipse(xx, yy, 2.6 + (i % 3), 1.3, 0, 0, TAU)
    x.fill()
  }
  x.restore()
}

function paintFarTrees(x: Ctx, S: SceneModel): void {
  for (const f of S.farTrees) {
    x.fillStyle = 'rgba(214,123,158,0.75)'
    x.beginPath()
    x.arc(f.x, f.y, f.s, 0, TAU)
    x.fill()
    x.fillStyle = 'rgba(243,170,198,0.5)'
    x.beginPath()
    x.arc(f.x - f.s * 0.25, f.y - f.s * 0.3, f.s * 0.6, 0, TAU)
    x.fill()
  }
}

function paintTree(x: Ctx, t: Tree): void {
  const { s } = t
  // ground shadow
  x.fillStyle = 'rgba(95,55,18,0.22)'
  x.beginPath()
  x.ellipse(t.x, t.y + s * 0.012, s * 0.3, s * 0.05, 0, 0, TAU)
  x.fill()
  // trunk
  x.strokeStyle = P.trunk
  x.lineCap = 'round'
  x.lineWidth = s * 0.045
  x.beginPath()
  x.moveTo(t.x, t.y)
  x.quadraticCurveTo(t.x + s * 0.03, t.y - s * 0.25, t.x - s * 0.02, t.y - s * 0.46)
  x.stroke()
  x.lineWidth = s * 0.022
  x.beginPath()
  x.moveTo(t.x - s * 0.005, t.y - s * 0.3)
  x.quadraticCurveTo(t.x + s * 0.12, t.y - s * 0.42, t.x + s * 0.16, t.y - s * 0.52)
  x.stroke()
  x.beginPath()
  x.moveTo(t.x - s * 0.01, t.y - s * 0.36)
  x.quadraticCurveTo(t.x - s * 0.14, t.y - s * 0.46, t.x - s * 0.17, t.y - s * 0.55)
  x.stroke()
  // canopy blobs (light from upper-left); dark base pass first for depth
  const cy = t.y - s * 0.6,
    R = s * 0.42
  x.fillStyle = P.canopy[0]
  x.beginPath()
  x.ellipse(t.x, cy + R * 0.08, R * 0.92, R * 0.74, 0, 0, TAU)
  x.fill()
  for (const b of t.blobs) {
    const bx = t.x + b.dx * R,
      by = cy + b.dy * R
    const light = 0.5 - (b.dx * 0.3 + b.dy * 0.62) + (b.c - 0.5) * 0.22 // upper-left lighter + jitter
    let c: string
    if (light > 0.78) c = P.canopyHi
    else
      c =
        P.canopy[
          Math.max(0, Math.min(P.canopy.length - 1, Math.floor(light * (P.canopy.length + 0.8))))
        ]
    x.fillStyle = c
    x.beginPath()
    x.arc(bx, by, b.r * R * 1.3, 0, TAU)
    x.fill()
  }
}

function paintTufts(x: Ctx, S: SceneModel): void {
  for (const tf of S.tufts) {
    if (tf.kind < 0.72) {
      x.strokeStyle = tf.kind < 0.36 ? P.grassLight : P.grassDark
      x.lineWidth = Math.max(1, tf.s * 0.14)
      x.beginPath()
      x.moveTo(tf.x, tf.y)
      x.quadraticCurveTo(tf.x + tf.s * 0.4, tf.y - tf.s * 0.7, tf.x + tf.s * 0.2, tf.y - tf.s * 1.3)
      x.stroke()
    } else {
      x.fillStyle = tf.kind < 0.86 ? 'rgba(244,168,196,0.8)' : 'rgba(255,250,240,0.8)'
      x.beginPath()
      x.arc(tf.x, tf.y, Math.max(1.2, tf.s * 0.16), 0, TAU)
      x.fill()
    }
  }
}

function paintPetals(x: Ctx, S: SceneModel, t: number): void {
  for (const p of S.petals) {
    const yy = ((p.y + p.vy * t) % (S.H + 30)) - 15
    const xx = p.x + Math.sin(t * 0.9 + p.ph) * p.sway
    x.save()
    x.translate(xx, yy)
    x.rotate(p.rot + t * 0.6 + p.ph)
    x.fillStyle = 'rgba(244,168,196,0.85)'
    x.beginPath()
    x.ellipse(0, 0, p.s, p.s * 0.55, 0, 0, TAU)
    x.fill()
    x.restore()
  }
}

/* ---------- compose (mock-identical order) ---------- */
function renderScene(x: Ctx, t: number, S: SceneModel): void {
  paintSky(x, S)
  for (const c of S.clouds) {
    const cx = ((c.x + c.v * t) % (S.W * 1.3)) - S.W * 0.15
    paintCloud(x, cx, c.y, c.s)
  }
  paintMountains(x, S)
  paintLand(x, S)
  paintFarTrees(x, S)
  paintRiver(x, S)
  paintReflections(x, S)
  paintShimmer(x, S, t)
  // bank trees back-to-front, then tufts, then foreground trees
  const sorted = [...S.trees].sort((a, b) => a.y - b.y)
  for (const tr of sorted) if (tr.y <= S.H * 0.8) paintTree(x, tr)
  paintTufts(x, S)
  for (const tr of sorted) if (tr.y > S.H * 0.8) paintTree(x, tr)
  paintPetals(x, S, t)
}

/* ---------- SceneDef ---------- */
const THUMB =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="54">' +
      '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#3f9fe6"/><stop offset="1" stop-color="#d9effb"/>' +
      '</linearGradient></defs>' +
      '<rect width="96" height="27" fill="url(#s)"/>' +
      '<path d="M0 27 L14 17 L26 27 L52 21 L74 27 L84 18 L96 27 Z" fill="#b7cdde"/>' +
      '<rect y="27" width="96" height="27" fill="#cf8d44"/>' +
      '<path d="M44 27 L52 27 L72 54 L28 54 Z" fill="#3a7cc4"/>' +
      '<circle cx="16" cy="30" r="7" fill="#d96b92"/>' +
      '<circle cx="80" cy="32" r="9" fill="#e687ab"/>' +
      '<circle cx="33" cy="28" r="5" fill="#d96b92"/>' +
      '</svg>'
  )

export const blossomRiver: SceneDef = {
  id: 'blossom-river',
  label: 'Blossom River',
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

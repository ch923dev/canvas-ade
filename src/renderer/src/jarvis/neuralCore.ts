/**
 * Jarvis — the canvas-drawn "neural core" (mock rev 2, D7; panel rev 1 exhibit D): a
 * beating nucleus inside two rings of orbiting dots, ONE renderer with per-state tunings,
 * parameterized by size (44px panel header, 18px edge tab). Ported from the
 * approved mock's script verbatim where possible. Token hexes only, no glow/gradients —
 * literal copies of 4 tokens because <canvas> can't read CSS custom properties (the
 * planning/exportColors.ts precedent: keep in step with styles/tokens.css if they change).
 * Reduced motion: paint ONE static frame per mode change instead of looping (repo rule,
 * styles/motion.css §9).
 */

/** Literal token copies (tokens.css): --text-3, --text-faint, --accent, --accent-hover. */
const NEUTRAL = '#7b7b81'
const FAINT = '#46464b'
const ACCENT = '#4f8cff'
const BRIGHT = '#6ea0ff'

export type CoreMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting'

interface ModeTuning {
  orbit: number
  dot: string
  dotHi: string
  nuc: string
  beat: 'heart' | 'react' | 'still' | 'pulse'
  depth: number
  period: number
  arc?: boolean
}

/** Per-state tuning table — the mock's MODES, byte-for-byte. */
const MODES: Record<CoreMode, ModeTuning> = {
  idle: {
    orbit: 0.25,
    dot: FAINT,
    dotHi: NEUTRAL,
    nuc: NEUTRAL,
    beat: 'heart',
    depth: 0.18,
    period: 1.6
  },
  listening: {
    orbit: 0.45,
    dot: NEUTRAL,
    dotHi: ACCENT,
    nuc: ACCENT,
    beat: 'react',
    depth: 0.5,
    period: 1.0
  },
  thinking: {
    orbit: 2.2,
    dot: NEUTRAL,
    dotHi: '#c8c8cc',
    nuc: FAINT,
    beat: 'still',
    depth: 0.06,
    period: 1.0
  },
  speaking: {
    orbit: 0.6,
    dot: NEUTRAL,
    dotHi: ACCENT,
    nuc: BRIGHT,
    beat: 'pulse',
    depth: 0.32,
    period: 0.42
  },
  acting: {
    orbit: 1.2,
    dot: NEUTRAL,
    dotHi: ACCENT,
    nuc: NEUTRAL,
    beat: 'heart',
    depth: 0.12,
    period: 1.2,
    arc: true
  }
}

/** Default logical (CSS) core size — the backing store doubles it for crispness
 *  (mock D=44@22px). The panel surface reuses the same renderer at other sizes
 *  (44px header, 18px edge tab) via the `cssPx` parameter — geometry always draws in
 *  the fixed 44-unit space and scales to the backing store. */
const CORE_CSS_PX = 22
const D = 44

const gauss = (x: number, m: number, s: number): number =>
  Math.exp(-((x - m) * (x - m)) / (2 * s * s))

/** Size the canvas for `cssPx` (2× supersample × DPR) and return a paint(ms, mode) fn. */
function createCorePainter(
  cv: HTMLCanvasElement,
  cssPx: number
): ((ms: number, mode: CoreMode) => void) | null {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  const backing = cssPx * 2 * dpr
  cv.width = backing
  cv.height = backing
  cv.style.width = `${cssPx}px`
  cv.style.height = `${cssPx}px`
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.scale(backing / D, backing / D)
  const C = D / 2

  const dots: { r: number; a: number; ph: number; s: number }[] = []
  for (let i = 0; i < 6; i++) dots.push({ r: 16, a: (i / 6) * Math.PI * 2, ph: i * 1.7, s: 1 })
  for (let i = 0; i < 4; i++)
    dots.push({ r: 10, a: (i / 4) * Math.PI * 2 + 0.6, ph: i * 2.3, s: -1.4 })

  const nucleusScale = (m: ModeTuning, t: number): number => {
    if (m.beat === 'heart') {
      const p = t % m.period
      return 1 + m.depth * (gauss(p, 0.1, 0.055) + 0.55 * gauss(p, 0.32, 0.06))
    }
    if (m.beat === 'pulse')
      return 1 + m.depth * (0.5 + 0.5 * Math.sin((t / m.period) * Math.PI * 2))
    if (m.beat === 'react')
      return (
        1 +
        m.depth *
          Math.max(
            0,
            0.45 * Math.sin(t * 5.1) +
              0.35 * Math.sin(t * 8.7 + 1.4) +
              0.2 * Math.sin(t * 2.3 + 0.5)
          )
      )
    return 1
  }

  return (ms: number, mode: CoreMode): void => {
    const m = MODES[mode]
    const t = ms / 1000
    ctx.clearRect(0, 0, D, D)
    const ns = nucleusScale(m, t)
    for (const d of dots) {
      const a = d.a + t * m.orbit * d.s
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.8 + d.ph))
      const rr = d.r + (m.beat === 'pulse' ? (ns - 1) * 6 : 0)
      ctx.globalAlpha = tw
      ctx.fillStyle = tw > 0.8 ? m.dotHi : m.dot
      ctx.beginPath()
      ctx.arc(C + Math.cos(a) * rr, C + Math.sin(a) * rr, 1.6, 0, 7)
      ctx.fill()
    }
    if (m.arc) {
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.5
      ctx.lineCap = 'round'
      const a0 = t * 2.4
      ctx.beginPath()
      ctx.arc(C, C, 16, a0, a0 + 1.5)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = m.nuc
    ctx.beginPath()
    ctx.arc(C, C, 3.4 * ns, 0, 7)
    ctx.fill()
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = m.nuc
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(C, C, 5.6 * ns, 0, 7)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/** A fixed paint phase that reads well for every beat type (static frames). */
const STATIC_PHASE_MS = 400

/**
 * Start the core renderer on `cv` at `cssPx` (default 22 — the island-era size; the
 * panel header passes 44). `getMode` is read every frame so state flips need no restart.
 * Returns a dispose fn. Under prefers-reduced-motion the loop is replaced by one static
 * frame per mode change (a lightweight poll at 4 Hz repaints only when it changed).
 */
export function startNeuralCore(
  cv: HTMLCanvasElement,
  getMode: () => CoreMode,
  cssPx: number = CORE_CSS_PX
): () => void {
  const paint = createCorePainter(cv, cssPx)
  if (!paint) return () => {}

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) {
    // One static frame per mode; a light poll repaints only on change (no rAF loop).
    let lastMode: CoreMode | null = null
    const tick = (): void => {
      const mode = getMode()
      if (mode !== lastMode) {
        lastMode = mode
        paint(STATIC_PHASE_MS, mode)
      }
    }
    tick()
    const iv = window.setInterval(tick, 250)
    return () => window.clearInterval(iv)
  }

  let raf = 0
  const frame = (ms: number): void => {
    paint(ms, getMode())
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  return () => cancelAnimationFrame(raf)
}

/**
 * Paint ONE static frame — the collapsed edge tab's mini core (18px, deliberately no
 * rAF/interval while the panel is closed, KICKOFF-PANEL §4: closed Jarvis stays cheap).
 */
export function paintNeuralCoreFrame(cv: HTMLCanvasElement, mode: CoreMode, cssPx: number): void {
  createCorePainter(cv, cssPx)?.(STATIC_PHASE_MS, mode)
}

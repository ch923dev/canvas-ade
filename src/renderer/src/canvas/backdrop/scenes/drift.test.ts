// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { drift } from './drift'
import type { SceneHandle } from '../sceneRegistry'

/**
 * Drift paints no gradients (it is a dot grid), so the per-frame fingerprint is
 * `fillRect` — called once for the void clear plus once per lattice dot every frame.
 * The handle-contract tests therefore assert fillRect DELTAS (painted vs not) rather
 * than an exact frame index; the lifecycle gates are identical to blossomRiver's.
 */
function makeFakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number> } {
  const calls = new Map<string, number>()
  const bump = (k: string): void => {
    calls.set(k, (calls.get(k) ?? 0) + 1)
  }
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return () => bump(prop)
      },
      set() {
        return true
      }
    }
  ) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = []
let nextRaf = 1
function pump(now: number): void {
  const q = rafQueue
  rafQueue = []
  for (const r of q) r.cb(now)
}

let roCallback: (() => void) | null = null
let roObserved: Element[] = []
class ROStub {
  constructor(cb: ResizeObserverCallback) {
    roCallback = () => cb([], this as unknown as ResizeObserver)
  }
  observe(el: Element): void {
    roObserved.push(el)
  }
  unobserve(): void {}
  disconnect(): void {
    roObserved = []
  }
}

let calls: Map<string, number>
const fillRects = (): number => calls.get('fillRect') ?? 0

function makeCanvas(cw = 0, ch = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  if (cw > 0) Object.defineProperty(canvas, 'clientWidth', { value: cw, configurable: true })
  if (ch > 0) Object.defineProperty(canvas, 'clientHeight', { value: ch, configurable: true })
  return canvas
}

function create(canvas: HTMLCanvasElement, reducedMotion = false): SceneHandle {
  return drift.create(canvas, { reducedMotion })
}

beforeEach(() => {
  rafQueue = []
  nextRaf = 1
  roCallback = null
  roObserved = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextRaf++
    rafQueue.push({ id, cb })
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue = rafQueue.filter((r) => r.id !== id)
  })
  vi.stubGlobal('ResizeObserver', ROStub)
  const fake = makeFakeCtx()
  calls = fake.calls
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.ctx as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('drift scene handle', () => {
  it('create() returns a handle without painting or scheduling anything', () => {
    create(makeCanvas())
    expect(fillRects()).toBe(0)
    expect(rafQueue.length).toBe(0)
    expect(roObserved.length).toBe(0)
  })

  it('renderStill() paints (the unanimated grid) once and never schedules a rAF', () => {
    const h = create(makeCanvas(), true)
    h.renderStill()
    expect(fillRects()).toBeGreaterThan(0)
    expect(rafQueue.length).toBe(0)
  })

  it('start(): first tick paints, the 33ms gate skips early frames and admits late ones', () => {
    const h = create(makeCanvas())
    h.start()
    expect(rafQueue.length).toBe(1)
    pump(16) // first tick always paints (lastDraw sentinel)
    const afterFirst = fillRects()
    expect(afterFirst).toBeGreaterThan(0)
    pump(26) // 10ms later — gated out, no new paint
    expect(fillRects()).toBe(afterFirst)
    pump(60) // 44ms after the last draw — admitted
    expect(fillRects()).toBeGreaterThan(afterFirst)
    expect(rafQueue.length).toBe(1) // loop keeps itself alive
    h.stop()
  })

  it('start() is idempotent — a double start never doubles the loop', () => {
    const h = create(makeCanvas())
    h.start()
    h.start()
    expect(rafQueue.length).toBe(1)
    h.stop()
  })

  it('stop() cancels the pending frame and is idempotent', () => {
    const h = create(makeCanvas())
    h.start()
    h.stop()
    h.stop()
    expect(rafQueue.length).toBe(0)
    pump(100)
    expect(fillRects()).toBe(0) // start() ticked nothing before stop
    expect(roObserved.length).toBe(0)
  })

  it('reducedMotion: start() is a complete no-op — zero rAF, zero paints', () => {
    const h = create(makeCanvas(), true)
    h.start()
    expect(rafQueue.length).toBe(0)
    expect(fillRects()).toBe(0)
  })

  it('clamps the buffer dpr at 1.5', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true })
    const canvas = makeCanvas(800, 600)
    create(canvas, true).renderStill()
    expect(canvas.width).toBe(1200) // 800 * 1.5, not 800 * 3
    expect(canvas.height).toBe(900)
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
  })

  it('resize rebuilds the buffer and repaints a parked still', () => {
    const canvas = makeCanvas(800, 600)
    create(canvas, true).renderStill()
    expect(canvas.width).toBe(800)
    const before = fillRects()
    Object.defineProperty(canvas, 'clientWidth', { value: 1000, configurable: true })
    roCallback?.()
    expect(canvas.width).toBe(1000)
    expect(fillRects()).toBeGreaterThan(before) // the still re-painted at the new size
  })

  it('zero-size element falls back to a 1920x1080 buffer, never throws', () => {
    const canvas = makeCanvas()
    create(canvas, true).renderStill()
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    expect(fillRects()).toBeGreaterThan(0)
  })

  it('a null 2D context (headless) is painless — sizing still works, painting no-ops', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never)
    const canvas = makeCanvas(640, 360)
    const h = drift.create(canvas, { reducedMotion: true })
    expect(() => h.renderStill()).not.toThrow()
    expect(canvas.width).toBe(640)
  })
})

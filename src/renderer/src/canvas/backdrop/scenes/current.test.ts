// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { current } from './current'
import type { SceneHandle } from '../sceneRegistry'

/**
 * Current is stateful (trail buffer + dt-integrated particles), so two fingerprints:
 * `fillRect` (void clear + per-frame trail fade + grid dots) tracks frames painted, and
 * `beginPath` tracks per-particle work — exactly DENSITY (150) strokes per still frame,
 * which proves the seeded syncParts populated the full particle set.
 */
const DENSITY = 150

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
const beginPaths = (): number => calls.get('beginPath') ?? 0

function makeCanvas(cw = 0, ch = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  if (cw > 0) Object.defineProperty(canvas, 'clientWidth', { value: cw, configurable: true })
  if (ch > 0) Object.defineProperty(canvas, 'clientHeight', { value: ch, configurable: true })
  return canvas
}

function create(canvas: HTMLCanvasElement, reducedMotion = false): SceneHandle {
  return current.create(canvas, { reducedMotion })
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

describe('current scene handle', () => {
  it('create() returns a handle without painting or scheduling anything', () => {
    create(makeCanvas())
    expect(fillRects()).toBe(0)
    expect(beginPaths()).toBe(0)
    expect(rafQueue.length).toBe(0)
    expect(roObserved.length).toBe(0)
  })

  it('renderStill() traces exactly one streamline per particle and schedules no rAF', () => {
    const h = create(makeCanvas(800, 600), true)
    h.renderStill()
    expect(beginPaths()).toBe(DENSITY) // seeded syncParts populated the full set
    expect(fillRects()).toBeGreaterThan(0) // void clear + grid dots
    expect(rafQueue.length).toBe(0)
  })

  it('start(): first tick paints, the 33ms gate skips early frames and admits late ones', () => {
    const h = create(makeCanvas(800, 600))
    h.start()
    expect(rafQueue.length).toBe(1)
    pump(16) // first tick always paints
    const afterFirst = beginPaths()
    expect(afterFirst).toBe(DENSITY) // one comet segment per particle
    pump(26) // gated out
    expect(beginPaths()).toBe(afterFirst)
    pump(60) // admitted — another DENSITY segments
    expect(beginPaths()).toBe(afterFirst * 2)
    expect(rafQueue.length).toBe(1)
    h.stop()
  })

  it('start() is idempotent — a double start never doubles the loop', () => {
    const h = create(makeCanvas(800, 600))
    h.start()
    h.start()
    expect(rafQueue.length).toBe(1)
    h.stop()
  })

  it('stop() cancels the pending frame and is idempotent', () => {
    const h = create(makeCanvas(800, 600))
    h.start()
    h.stop()
    h.stop()
    expect(rafQueue.length).toBe(0)
    pump(100)
    expect(beginPaths()).toBe(0)
    expect(roObserved.length).toBe(0)
  })

  it('reducedMotion: start() is a complete no-op — zero rAF, zero paints', () => {
    const h = create(makeCanvas(800, 600), true)
    h.start()
    expect(rafQueue.length).toBe(0)
    expect(fillRects()).toBe(0)
    expect(beginPaths()).toBe(0)
  })

  it('clamps the buffer dpr at 1.5', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true })
    const canvas = makeCanvas(800, 600)
    create(canvas, true).renderStill()
    expect(canvas.width).toBe(1200)
    expect(canvas.height).toBe(900)
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
  })

  it('resize rebuilds the buffer and repaints a parked still', () => {
    const canvas = makeCanvas(800, 600)
    create(canvas, true).renderStill()
    expect(canvas.width).toBe(800)
    const before = beginPaths()
    Object.defineProperty(canvas, 'clientWidth', { value: 1000, configurable: true })
    roCallback?.()
    expect(canvas.width).toBe(1000)
    expect(beginPaths()).toBe(before + DENSITY) // restamped the still at the new size
  })

  it('zero-size element falls back to a 1920x1080 buffer, never throws', () => {
    const canvas = makeCanvas()
    create(canvas, true).renderStill()
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    expect(beginPaths()).toBe(DENSITY)
  })

  it('a null 2D context (headless) is painless — sizing still works, painting no-ops', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never)
    const canvas = makeCanvas(640, 360)
    const h = current.create(canvas, { reducedMotion: true })
    expect(() => h.renderStill()).not.toThrow()
    expect(canvas.width).toBe(640)
  })
})

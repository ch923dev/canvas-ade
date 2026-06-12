// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { blossomRiver } from './blossomRiver'
import type { SceneHandle } from '../sceneRegistry'

/**
 * The handle contract under test (pr2-acceptance.md §3): paint counting works by
 * fingerprint — renderScene calls createLinearGradient exactly 3 times per frame
 * (sky + land + river gradients), so frames = gradientCalls / 3 with no reliance
 * on jsdom canvas (a Proxy stands in for the 2D context).
 */
function makeFakeCtx(): { ctx: CanvasRenderingContext2D; calls: Map<string, number> } {
  const calls = new Map<string, number>()
  const bump = (k: string): void => {
    calls.set(k, (calls.get(k) ?? 0) + 1)
  }
  const gradient = { addColorStop: (): void => undefined }
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'createLinearGradient')
          return () => {
            bump(prop)
            return gradient
          }
        return () => {
          bump(prop)
        }
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
/** Fire every queued rAF callback once at timestamp `now` (ms). */
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
const frames = (): number => (calls.get('createLinearGradient') ?? 0) / 3

function makeCanvas(cw = 0, ch = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  if (cw > 0) Object.defineProperty(canvas, 'clientWidth', { value: cw, configurable: true })
  if (ch > 0) Object.defineProperty(canvas, 'clientHeight', { value: ch, configurable: true })
  return canvas
}

function create(canvas: HTMLCanvasElement, reducedMotion = false): SceneHandle {
  return blossomRiver.create(canvas, { reducedMotion })
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

describe('blossomRiver scene handle', () => {
  it('create() returns a handle without painting or scheduling anything', () => {
    create(makeCanvas())
    expect(frames()).toBe(0)
    expect(rafQueue.length).toBe(0)
    expect(roObserved.length).toBe(0)
  })

  it('renderStill() paints exactly one frame and never schedules a rAF (PF-3)', () => {
    const h = create(makeCanvas(), true)
    h.renderStill()
    expect(frames()).toBe(1)
    expect(rafQueue.length).toBe(0)
  })

  it('start(): first tick paints, then the 33ms gate skips early frames and admits late ones (AC-5)', () => {
    const h = create(makeCanvas())
    h.start()
    expect(rafQueue.length).toBe(1)
    pump(16) // first tick always paints (lastDraw sentinel)
    expect(frames()).toBe(1)
    pump(26) // 10ms later — gated out
    expect(frames()).toBe(1)
    pump(60) // 44ms after the last draw — admitted
    expect(frames()).toBe(2)
    expect(rafQueue.length).toBe(1) // loop keeps itself alive
    h.stop()
  })

  it('start() is idempotent — a double start never doubles the loop', () => {
    const h = create(makeCanvas())
    h.start()
    h.start()
    expect(rafQueue.length).toBe(1)
    pump(16)
    expect(rafQueue.length).toBe(1)
    h.stop()
  })

  it('stop() cancels the pending frame and is idempotent (PF-3)', () => {
    const h = create(makeCanvas())
    h.start()
    h.stop()
    h.stop()
    expect(rafQueue.length).toBe(0)
    pump(100)
    expect(frames()).toBe(0) // start() ticked nothing before stop
    expect(roObserved.length).toBe(0) // observer disconnected with the loop
  })

  it('reducedMotion: start() is a complete no-op — zero rAF, zero paints (AC-6)', () => {
    const h = create(makeCanvas(), true)
    h.start()
    expect(rafQueue.length).toBe(0)
    expect(frames()).toBe(0)
  })

  it('clamps the buffer dpr at 1.5 (PF-2)', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true })
    const canvas = makeCanvas(800, 600)
    const h = create(canvas, true)
    h.renderStill()
    expect(canvas.width).toBe(1200) // 800 * 1.5, not 800 * 3
    expect(canvas.height).toBe(900)
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
  })

  it('resize rebuilds the buffer and repaints a parked still (AC-10)', () => {
    const canvas = makeCanvas(800, 600)
    const h = create(canvas, true)
    h.renderStill()
    expect(canvas.width).toBe(800)
    expect(frames()).toBe(1)
    Object.defineProperty(canvas, 'clientWidth', { value: 1000, configurable: true })
    roCallback?.()
    expect(canvas.width).toBe(1000)
    expect(frames()).toBe(2) // the still re-painted at the new size
  })

  it('zero-size element (jsdom / pre-layout) falls back to a 1920x1080 buffer, never throws', () => {
    const canvas = makeCanvas()
    const h = create(canvas, true)
    h.renderStill()
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    expect(frames()).toBe(1)
  })

  it('a null 2D context (headless) is painless — sizing still works, painting no-ops', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never)
    const canvas = makeCanvas(640, 360)
    const h = blossomRiver.create(canvas, { reducedMotion: true })
    expect(() => h.renderStill()).not.toThrow()
    expect(canvas.width).toBe(640)
  })
})

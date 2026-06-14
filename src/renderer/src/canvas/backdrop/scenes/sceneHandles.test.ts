// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listScenes, type SceneDef, type SceneHandle } from '../sceneRegistry'

/**
 * Parametrized SceneHandle contract — every registered scene (the PR 3a ambient pair,
 * the PR 3b scenic roster, blossom-river) runs the SAME lifecycle checks here, so a new
 * scene is covered the moment it lands in the registry. The bespoke per-scene tests
 * (blossomRiver / drift / current) keep their scene-specific assertions; this file is
 * the uniform floor.
 *
 * Frame detection is renderer-agnostic: every scene fills at least the void background
 * each painted frame, so the running `fillRect` count STRICTLY increases per painted
 * frame and is unchanged across a gated (sub-33ms) frame. We assert that relation
 * rather than an exact per-frame count, which would differ for stateful scenes (e.g.
 * `current` paints an extra solid-void fillRect only on its first frame).
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
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
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
function pump(now: number): void {
  const q = rafQueue
  rafQueue = []
  for (const r of q) r.cb(now)
}

let roObserved: Element[] = []
class ROStub {
  observe(el: Element): void {
    roObserved.push(el)
  }
  unobserve(): void {}
  disconnect(): void {
    roObserved = []
  }
}

let calls: Map<string, number>
const fills = (): number => calls.get('fillRect') ?? 0

function makeCanvas(cw = 0, ch = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  if (cw > 0) Object.defineProperty(canvas, 'clientWidth', { value: cw, configurable: true })
  if (ch > 0) Object.defineProperty(canvas, 'clientHeight', { value: ch, configurable: true })
  return canvas
}

function handle(def: SceneDef, canvas: HTMLCanvasElement, reducedMotion = false): SceneHandle {
  return def.create(canvas, { reducedMotion })
}

beforeEach(() => {
  rafQueue = []
  nextRaf = 1
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

for (const def of listScenes()) {
  describe(`SceneHandle contract: ${def.id}`, () => {
    it('create() paints nothing and schedules nothing', () => {
      handle(def, makeCanvas())
      expect(fills()).toBe(0)
      expect(rafQueue.length).toBe(0)
      expect(roObserved.length).toBe(0)
    })

    it('renderStill() paints exactly one frame and never schedules a rAF', () => {
      const h = handle(def, makeCanvas(), true)
      h.renderStill()
      expect(fills()).toBeGreaterThan(0)
      expect(rafQueue.length).toBe(0)
    })

    it('start(): first tick paints, the 33ms gate skips early frames and admits late ones', () => {
      const h = handle(def, makeCanvas())
      h.start()
      expect(rafQueue.length).toBe(1)
      pump(16) // first tick always paints (lastDraw sentinel)
      const afterFirst = fills()
      expect(afterFirst).toBeGreaterThan(0)
      pump(26) // 10ms later -> gated out, no new paint
      expect(fills()).toBe(afterFirst)
      pump(60) // 44ms after the last draw -> admitted, more fills
      expect(fills()).toBeGreaterThan(afterFirst)
      expect(rafQueue.length).toBe(1) // loop keeps itself alive
      h.stop()
    })

    it('start() is idempotent — a double start never doubles the loop', () => {
      const h = handle(def, makeCanvas())
      h.start()
      h.start()
      expect(rafQueue.length).toBe(1)
      h.stop()
    })

    it('stop() cancels the pending frame, disconnects the observer, and is idempotent', () => {
      const h = handle(def, makeCanvas())
      h.start()
      h.stop()
      h.stop()
      expect(rafQueue.length).toBe(0)
      expect(roObserved.length).toBe(0)
    })

    it('reducedMotion: start() is a complete no-op — zero rAF, zero paints', () => {
      const h = handle(def, makeCanvas(), true)
      h.start()
      expect(rafQueue.length).toBe(0)
      expect(fills()).toBe(0)
    })

    it('clamps the buffer dpr at 1.5', () => {
      Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true })
      const canvas = makeCanvas(800, 600)
      handle(def, canvas, true).renderStill()
      expect(canvas.width).toBe(1200) // 800 * 1.5, not 800 * 3
      expect(canvas.height).toBe(900)
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
    })

    it('zero-size element (jsdom / pre-layout) falls back to a 1920x1080 buffer', () => {
      const canvas = makeCanvas()
      handle(def, canvas, true).renderStill()
      expect(canvas.width).toBe(1920)
      expect(canvas.height).toBe(1080)
    })

    it('a null 2D context (headless) is painless — sizing still works, painting no-ops', () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never)
      const canvas = makeCanvas(640, 360)
      const h = handle(def, canvas, true)
      expect(() => h.renderStill()).not.toThrow()
      expect(canvas.width).toBe(640)
    })
  })
}

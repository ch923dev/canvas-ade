import { describe, it, expect } from 'vitest'
import { clampZoom, wheelZoom, stepZoom, clampPan, ZOOM_MIN, ZOOM_MAX } from './diagramZoom'

describe('clampZoom', () => {
  it('clamps into [ZOOM_MIN, ZOOM_MAX] and survives NaN', () => {
    expect(clampZoom(0.05)).toBe(ZOOM_MIN)
    expect(clampZoom(99)).toBe(ZOOM_MAX)
    expect(clampZoom(2)).toBe(2)
    expect(clampZoom(NaN)).toBe(ZOOM_MIN)
  })
})

describe('wheelZoom / stepZoom', () => {
  it('wheel-up zooms in, wheel-down zooms out below fit, clamped at the floor/ceiling', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1) // up = in
    expect(wheelZoom(1, 100)).toBeLessThan(1) // down = out, past fit (infinite-canvas)
    expect(wheelZoom(ZOOM_MIN, 100)).toBe(ZOOM_MIN) // floor
    expect(wheelZoom(ZOOM_MAX, -100)).toBe(ZOOM_MAX) // ceiling
    expect(stepZoom(2, 1)).toBeGreaterThan(2)
    expect(stepZoom(2, -1)).toBeLessThan(2)
  })
})

describe('clampPan', () => {
  it('pins pan to the scaled overflow (no pan at fit; ±viewport·(z−1)/2 per side)', () => {
    expect(clampPan({ x: 50, y: 50 }, { w: 400, h: 300 }, 1)).toEqual({ x: 0, y: 0 })
    // at 2× a 400×300 viewport, max offset is 200×150 per side
    expect(clampPan({ x: 999, y: -999 }, { w: 400, h: 300 }, 2)).toEqual({ x: 200, y: -150 })
    expect(clampPan({ x: 30, y: -20 }, { w: 400, h: 300 }, 2)).toEqual({ x: 30, y: -20 })
  })
})

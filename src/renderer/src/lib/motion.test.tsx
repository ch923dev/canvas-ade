import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAMERA_MS, EASE_STANDARD, cameraAnim, cubicBezier, prefersReducedMotion } from './motion'

describe('cubicBezier', () => {
  it('pins the endpoints exactly', () => {
    expect(EASE_STANDARD(0)).toBe(0)
    expect(EASE_STANDARD(1)).toBe(1)
  })

  it('clamps out-of-range input', () => {
    expect(EASE_STANDARD(-0.5)).toBe(0)
    expect(EASE_STANDARD(2)).toBe(1)
  })

  it('is monotonic and within [0,1] across the curve', () => {
    let prev = 0
    for (let i = 1; i <= 20; i++) {
      const y = EASE_STANDARD(i / 20)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
  })

  it('linear curve is the identity', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    expect(linear(0.25)).toBeCloseTo(0.25, 5)
    expect(linear(0.5)).toBeCloseTo(0.5, 5)
    expect(linear(0.75)).toBeCloseTo(0.75, 5)
  })

  it('(.2,.7,.2,1) front-loads (ease-out): midpoint past 0.5', () => {
    // cubic-bezier(.2,.7,.2,1) decelerates — output is ahead of input early on.
    expect(EASE_STANDARD(0.5)).toBeGreaterThan(0.5)
  })
})

describe('cameraAnim', () => {
  const realMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = realMatchMedia
    vi.restoreAllMocks()
  })

  function setReducedMotion(reduce: boolean): void {
    window.matchMedia = ((q: string) => ({
      matches: reduce && q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
  }

  it('animates at CAMERA_MS with the standard ease by default', () => {
    setReducedMotion(false)
    const out = cameraAnim({ padding: 0.2 })
    expect(out.duration).toBe(CAMERA_MS)
    expect(out.ease).toBe(EASE_STANDARD)
    expect(out.padding).toBe(0.2)
  })

  it('collapses to instant under prefers-reduced-motion', () => {
    setReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(cameraAnim({ padding: 0.2 }).duration).toBe(0)
  })

  it('preserves the wrapped options', () => {
    setReducedMotion(false)
    const out = cameraAnim({ maxZoom: 1, nodes: [{ id: 'a' }] })
    expect(out.maxZoom).toBe(1)
    expect(out.nodes).toEqual([{ id: 'a' }])
  })
})

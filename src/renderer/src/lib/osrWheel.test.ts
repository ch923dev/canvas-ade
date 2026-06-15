import { describe, it, expect } from 'vitest'
import { mapOsrWheel, LINE_HEIGHT_PX } from './osrWheel'

describe('mapOsrWheel', () => {
  it('passes pixel-mode deltas through 1:1 with the precise hint', () => {
    const out = mapOsrWheel({ deltaX: 12, deltaY: -8, deltaMode: 0 }, 800)
    expect(out).toEqual({
      deltaX: -12,
      deltaY: 8,
      hasPreciseScrollingDeltas: true,
      canScroll: true
    })
  })

  it('scales line-mode deltas by the line height (precise hint off)', () => {
    const out = mapOsrWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800)
    expect(out.deltaY).toBe(-3 * LINE_HEIGHT_PX)
    expect(out.hasPreciseScrollingDeltas).toBe(false)
  })

  it('scales page-mode deltas by the page height', () => {
    const out = mapOsrWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 834)
    expect(out.deltaY).toBe(-834)
    expect(out.hasPreciseScrollingDeltas).toBe(false)
  })

  it('negates the sign (DOM down-positive → Electron up-positive)', () => {
    expect(mapOsrWheel({ deltaX: 5, deltaY: 5, deltaMode: 0 }, 800).deltaY).toBeLessThan(0)
    expect(mapOsrWheel({ deltaX: 5, deltaY: -5, deltaMode: 0 }, 800).deltaY).toBeGreaterThan(0)
  })

  it('maps zero to zero', () => {
    const out = mapOsrWheel({ deltaX: 0, deltaY: 0, deltaMode: 1 }, 800)
    // -0 is acceptable (-0 * 40), so compare magnitude rather than sign-of-zero.
    expect(Math.abs(out.deltaX)).toBe(0)
    expect(Math.abs(out.deltaY)).toBe(0)
  })
})

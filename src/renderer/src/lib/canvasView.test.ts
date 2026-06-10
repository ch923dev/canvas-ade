import { describe, it, expect } from 'vitest'
import { Z_MIN, Z_MAX, LOD_ZOOM, GRID_GAP, isLod, gridDotOpacity, FIT_FRAME, OVERVIEW_FRAME } from './canvasView'

describe('camera constants', () => {
  it('pins the zoom range and LOD threshold (DESIGN.md §5)', () => {
    expect(Z_MIN).toBe(0.1)
    expect(Z_MAX).toBe(2.5)
    expect(LOD_ZOOM).toBe(0.4)
    expect(GRID_GAP).toBe(24)
  })
})

// BUG-061 regression: OVERVIEW_FRAME must not zoom tighter than FIT_FRAME for small clusters
describe('camera framing presets', () => {
  it('BUG-061: OVERVIEW_FRAME.maxZoom does not exceed FIT_FRAME.maxZoom', () => {
    const overviewMax = (OVERVIEW_FRAME as { maxZoom?: number }).maxZoom ?? Z_MAX
    const fitMax = (FIT_FRAME as { maxZoom?: number }).maxZoom ?? Z_MAX
    expect(overviewMax).toBeLessThanOrEqual(fitMax)
  })

  it('BUG-061: OVERVIEW_FRAME has an explicit maxZoom (not inherited from the flow)', () => {
    expect((OVERVIEW_FRAME as { maxZoom?: number }).maxZoom).toBeDefined()
  })
})

describe('isLod', () => {
  it('is true strictly below the LOD threshold', () => {
    expect(isLod(0.39)).toBe(true)
    expect(isLod(0.1)).toBe(true)
  })

  it('is false at or above the threshold', () => {
    expect(isLod(0.4)).toBe(false)
    expect(isLod(0.41)).toBe(false)
    expect(isLod(1)).toBe(false)
  })
})

describe('gridDotOpacity', () => {
  it('is full opacity at and above ~40% zoom', () => {
    expect(gridDotOpacity(0.4)).toBe(1)
    expect(gridDotOpacity(1)).toBe(1)
    expect(gridDotOpacity(2.5)).toBe(1)
  })

  it('fades through the mid band (≈30% zoom → half)', () => {
    expect(gridDotOpacity(0.29)).toBeCloseTo(0.5, 5)
  })

  it('clamps to a 0.15 floor at and below the low band', () => {
    expect(gridDotOpacity(0.18)).toBe(0.15)
    expect(gridDotOpacity(0.1)).toBe(0.15)
  })

  it('never returns outside [0.15, 1]', () => {
    for (let z = 0.05; z <= 2.5; z += 0.05) {
      const op = gridDotOpacity(z)
      expect(op).toBeGreaterThanOrEqual(0.15)
      expect(op).toBeLessThanOrEqual(1)
    }
  })
})

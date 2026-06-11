import { describe, it, expect } from 'vitest'
import {
  Z_MIN,
  Z_MAX,
  LOD_ZOOM,
  GRID_GAP,
  ZOOM_SNAP_LO,
  ZOOM_SNAP_HI,
  isLod,
  gridDotOpacity,
  snapZoom,
  isCrispZoom,
  FIT_FRAME,
  OVERVIEW_FRAME
} from './canvasView'

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

// Terminal raster fix (docs/research/2026-06-11-terminal-font-blur.md): the snap band
// lands the everyday working zoom pixel-exact for the xterm WebGL canvas; isCrispZoom
// is the renderer-policy predicate (WebGL only at crisp settled zoom).
describe('snapZoom', () => {
  it('snaps the whole band (inclusive bounds) to exactly 1', () => {
    expect(snapZoom(ZOOM_SNAP_LO)).toBe(1)
    expect(snapZoom(0.97)).toBe(1)
    expect(snapZoom(1)).toBe(1)
    expect(snapZoom(1.03)).toBe(1)
    expect(snapZoom(ZOOM_SNAP_HI)).toBe(1)
  })

  it('passes through zooms outside the band untouched', () => {
    expect(snapZoom(0.9499)).toBe(0.9499)
    expect(snapZoom(1.0601)).toBe(1.0601)
    expect(snapZoom(0.5)).toBe(0.5)
    expect(snapZoom(2)).toBe(2)
    expect(snapZoom(Z_MIN)).toBe(Z_MIN)
    expect(snapZoom(Z_MAX)).toBe(Z_MAX)
  })

  it('band is asymmetric around 1 and sits inside plausibly-intentional levels', () => {
    expect(ZOOM_SNAP_LO).toBeGreaterThan(0.9) // 0.9 stays a reachable zoom level
    expect(ZOOM_SNAP_HI).toBeLessThan(1.1) // 1.1 stays a reachable zoom level
    expect(ZOOM_SNAP_LO).toBeLessThan(1)
    expect(ZOOM_SNAP_HI).toBeGreaterThan(1)
  })
})

describe('isCrispZoom', () => {
  it('is true only at 1 within float tolerance', () => {
    expect(isCrispZoom(1)).toBe(true)
    expect(isCrispZoom(1 + 1e-4)).toBe(true) // d3-zoom float residue
    expect(isCrispZoom(1 - 1e-4)).toBe(true)
  })

  it('is false at any real zoom level away from 1 (including inside the snap band)', () => {
    expect(isCrispZoom(0.97)).toBe(false) // pre-snap value — only the SNAPPED zoom is crisp
    expect(isCrispZoom(1.03)).toBe(false)
    expect(isCrispZoom(0.8)).toBe(false)
    expect(isCrispZoom(1.3)).toBe(false)
    expect(isCrispZoom(2)).toBe(false)
  })
})

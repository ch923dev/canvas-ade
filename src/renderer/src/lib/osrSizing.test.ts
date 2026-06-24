import { describe, it, expect } from 'vitest'
import {
  computeOsrSize,
  computeFullViewOsrSize,
  quantizeSupersample,
  OSR_MIN_SUPERSAMPLE,
  OSR_MAX_SUPERSAMPLE,
  type OsrSizeGeom
} from './osrSizing'

// A board large enough that deviceFitScale saturates at MAX_FIT_SCALE (1.1) for every
// preset — keeps the supersample arithmetic exact and preset-comparable.
const BIG = (viewport: OsrSizeGeom['viewport']): OsrSizeGeom => ({ w: 2000, h: 1500, viewport })

describe('quantizeSupersample', () => {
  it('rounds to the 0.25 step', () => {
    expect(quantizeSupersample(1.1)).toBe(1.0) // 4.4 → 4
    expect(quantizeSupersample(1.3)).toBe(1.25) // 5.2 → 5
    expect(quantizeSupersample(1.45)).toBe(1.5) // 5.8 → 6
  })
  it('clamps to [MIN, MAX]', () => {
    expect(quantizeSupersample(0.4)).toBe(OSR_MIN_SUPERSAMPLE) // floor
    expect(quantizeSupersample(0)).toBe(OSR_MIN_SUPERSAMPLE)
    expect(quantizeSupersample(3.0)).toBe(OSR_MAX_SUPERSAMPLE) // ceil
    expect(quantizeSupersample(10)).toBe(OSR_MAX_SUPERSAMPLE)
  })
  it('falls back to MIN on a non-finite input (Infinity is non-finite → safe MIN, not ceil)', () => {
    expect(quantizeSupersample(NaN)).toBe(OSR_MIN_SUPERSAMPLE)
    expect(quantizeSupersample(Infinity)).toBe(OSR_MIN_SUPERSAMPLE)
  })
})

describe('computeOsrSize — logical size (M4 reflow)', () => {
  it('logicalW/H is the preset CSS box, regardless of zoom/dpr', () => {
    expect(computeOsrSize(BIG('mobile'), 1, 1)).toMatchObject({ logicalW: 390, logicalH: 844 })
    expect(computeOsrSize(BIG('tablet'), 3, 2)).toMatchObject({ logicalW: 834, logicalH: 1112 })
    expect(computeOsrSize(BIG('desktop'), 0.2, 1)).toMatchObject({ logicalW: 1280, logicalH: 800 })
  })

  it('carries the wide-desktop tier logical box (1440p / 4K)', () => {
    expect(computeOsrSize(BIG('qhd'), 1, 1)).toMatchObject({ logicalW: 2560, logicalH: 1440 })
    expect(computeOsrSize(BIG('uhd'), 1, 1)).toMatchObject({ logicalW: 3840, logicalH: 2160 })
  })

  it('clamps the 4K supersample to the 2× cap (physical 3840×2 stays within GPU limits)', () => {
    // fit saturates at 1.1 for BIG; 1.1 × 2 × 2 = 4.4 → clamp 2.0, so physical ≤ 3840·2 = 7680.
    expect(computeOsrSize(BIG('uhd'), 2, 2).supersample).toBe(OSR_MAX_SUPERSAMPLE)
  })
})

describe('computeOsrSize — supersample (M1 sharpness)', () => {
  it('tracks deviceFitScale × settledZoom × dpr (fit saturates at 1.1 here)', () => {
    // 1.1 × 1 × 1 = 1.1 → 1.0
    expect(computeOsrSize(BIG('desktop'), 1, 1).supersample).toBe(1.0)
    // 1.1 × 1 × 2 = 2.2 → clamp 2.0
    expect(computeOsrSize(BIG('desktop'), 1, 2).supersample).toBe(2.0)
    // 1.1 × 2 × 1 = 2.2 → clamp 2.0
    expect(computeOsrSize(BIG('desktop'), 2, 1).supersample).toBe(2.0)
  })
  it('both zoom and dpr scale S (monotonic non-decreasing in zoom)', () => {
    const lo = computeOsrSize(BIG('desktop'), 0.5, 1).supersample
    const hi = computeOsrSize(BIG('desktop'), 2, 1).supersample
    expect(hi).toBeGreaterThanOrEqual(lo)
    expect(lo).toBe(1.0) // 0.55 floors to 1
  })
  it('never returns 0 / NaN when the board is smaller than its own chrome (fit=0 fallback)', () => {
    const tiny = computeOsrSize({ w: 10, h: 10, viewport: 'desktop' }, 1, 1)
    expect(tiny.supersample).toBe(1.0)
    expect(Number.isFinite(tiny.supersample)).toBe(true)
  })
  it('sanitizes a degenerate camera / dpr to 1', () => {
    expect(computeOsrSize(BIG('desktop'), 0, 1).supersample).toBeGreaterThanOrEqual(1)
    expect(computeOsrSize(BIG('desktop'), 1, 0).supersample).toBeGreaterThanOrEqual(1)
    expect(computeOsrSize(BIG('desktop'), NaN, NaN).supersample).toBe(1.0) // 1.1×1×1 → 1.0
  })
})

describe('computeFullViewOsrSize (PREV-01 — full-view supersample from the on-screen box)', () => {
  it('keeps the preset logical size (the page still reflows to the preset width)', () => {
    expect(computeFullViewOsrSize('mobile', 800, 1)).toMatchObject({ logicalW: 390, logicalH: 844 })
    expect(computeFullViewOsrSize('desktop', 2000, 1)).toMatchObject({
      logicalW: 1280,
      logicalH: 800
    })
  })

  it('S tracks (cssBoxWidth · dpr) / presetW — a bigger box → a crisper buffer', () => {
    // mobile preset 390: a 780-px box at dpr 1 → 2.0 (clamped at the 2× cap).
    expect(computeFullViewOsrSize('mobile', 780, 1).supersample).toBe(2.0)
    // a 390-px box at dpr 1 → exactly 1.0.
    expect(computeFullViewOsrSize('mobile', 390, 1).supersample).toBe(1.0)
    // desktop preset 1280: a 1600-px box at dpr 1 → 1.25 → quantized to 1.25.
    expect(computeFullViewOsrSize('desktop', 1600, 1).supersample).toBe(1.25)
  })

  it('clamps to the 2× cap for a large full-view box (the accept criterion)', () => {
    expect(computeFullViewOsrSize('desktop', 4000, 2).supersample).toBe(OSR_MAX_SUPERSAMPLE)
  })

  it('falls back safely on a zero / non-finite box or dpr (never 0 / NaN)', () => {
    expect(computeFullViewOsrSize('mobile', 0, 1).supersample).toBe(1.0) // box→presetW fallback
    expect(computeFullViewOsrSize('mobile', 800, 0).supersample).toBeGreaterThanOrEqual(1)
    expect(computeFullViewOsrSize('mobile', NaN, NaN).supersample).toBe(1.0)
    expect(Number.isFinite(computeFullViewOsrSize('mobile', NaN, NaN).supersample)).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import {
  worldRectToScreen,
  roundRect,
  rectsEqual,
  fitZoomFactor,
  fitZoomFactorForBounds,
  type Rect,
  type Viewport
} from './cameraBounds'

describe('worldRectToScreen', () => {
  it('is the identity map at zoom 1, vp (0,0), no offset', () => {
    const node: Rect = { x: 10, y: 20, width: 200, height: 120 }
    const vp: Viewport = { x: 0, y: 0, zoom: 1 }
    expect(worldRectToScreen(node, vp)).toEqual({ x: 10, y: 20, width: 200, height: 120 })
  })

  it('doubles size AND scales the origin at zoom 2', () => {
    const node: Rect = { x: 10, y: 20, width: 200, height: 120 }
    const vp: Viewport = { x: 0, y: 0, zoom: 2 }
    // origin scales by zoom: 10*2=20, 20*2=40; size doubles: 400 x 240
    expect(worldRectToScreen(node, vp)).toEqual({ x: 20, y: 40, width: 400, height: 240 })
  })

  it('halves size and origin at zoom 0.5', () => {
    const node: Rect = { x: 10, y: 20, width: 200, height: 120 }
    const vp: Viewport = { x: 0, y: 0, zoom: 0.5 }
    expect(worldRectToScreen(node, vp)).toEqual({ x: 5, y: 10, width: 100, height: 60 })
  })

  it('adds the viewport translate (vp.x / vp.y) at zoom 1', () => {
    const node: Rect = { x: 10, y: 20, width: 200, height: 120 }
    const vp: Viewport = { x: 100, y: -40, zoom: 1 }
    expect(worldRectToScreen(node, vp)).toEqual({ x: 110, y: -20, width: 200, height: 120 })
  })

  it('adds the paneOffset to x and y but not to size', () => {
    const node: Rect = { x: 10, y: 20, width: 200, height: 120 }
    const vp: Viewport = { x: 0, y: 0, zoom: 1 }
    expect(worldRectToScreen(node, vp, { x: 0, y: 84 })).toEqual({
      x: 10,
      y: 104,
      width: 200,
      height: 120
    })
  })

  it('handles negative world coordinates', () => {
    const node: Rect = { x: -50, y: -30, width: 80, height: 40 }
    const vp: Viewport = { x: 0, y: 0, zoom: 2 }
    expect(worldRectToScreen(node, vp)).toEqual({ x: -100, y: -60, width: 160, height: 80 })
  })

  it('combines paneOffset + viewport translate + zoom correctly', () => {
    // x = 0 + (-50) + 120*0.75 = 40 ; y = 84 + 30 + 240*0.75 = 294
    // width = 200*0.75 = 150 ; height = 120*0.75 = 90
    const node: Rect = { x: 120, y: 240, width: 200, height: 120 }
    const vp: Viewport = { x: -50, y: 30, zoom: 0.75 }
    expect(worldRectToScreen(node, vp, { x: 0, y: 84 })).toEqual({
      x: 40,
      y: 294,
      width: 150,
      height: 90
    })
  })

  it('does not mutate node, vp, or paneOffset', () => {
    const node: Rect = { x: 10, y: 20, width: 200, height: 120 }
    const vp: Viewport = { x: 5, y: 6, zoom: 2 }
    const paneOffset = { x: 7, y: 8 }
    worldRectToScreen(node, vp, paneOffset)
    expect(node).toEqual({ x: 10, y: 20, width: 200, height: 120 })
    expect(vp).toEqual({ x: 5, y: 6, zoom: 2 })
    expect(paneOffset).toEqual({ x: 7, y: 8 })
  })
})

describe('roundRect', () => {
  it('rounds .5 up (toward +Infinity) for positive fields', () => {
    expect(roundRect({ x: 0.5, y: 1.5, width: 2.5, height: 3.5 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })
  })

  it('rounds fractional positive values to the nearest integer', () => {
    expect(roundRect({ x: 0.4, y: 0.6, width: 199.49, height: 120.5 })).toEqual({
      x: 0,
      y: 1,
      width: 199,
      height: 121
    })
  })

  it('rounds negatives correctly (half rounds toward +Infinity per Math.round)', () => {
    // Math.round(-1.5) === -1, Math.round(-2.5) === -2, Math.round(-2.4) === -2, Math.round(-2.6) === -3
    expect(roundRect({ x: -1.5, y: -2.5, width: -2.4, height: -2.6 })).toEqual({
      x: -1,
      y: -2,
      width: -2,
      height: -3
    })
  })

  it('leaves already-integer fields unchanged', () => {
    expect(roundRect({ x: -100, y: 0, width: 160, height: 80 })).toEqual({
      x: -100,
      y: 0,
      width: 160,
      height: 80
    })
  })

  it('does not mutate its input', () => {
    const r: Rect = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
    roundRect(r)
    expect(r).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
  })
})

describe('rectsEqual', () => {
  const base: Rect = { x: 1, y: 2, width: 3, height: 4 }

  it('is true for field-identical rects (distinct object references)', () => {
    expect(rectsEqual(base, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
  })

  it('is false when x differs', () => {
    expect(rectsEqual(base, { x: 99, y: 2, width: 3, height: 4 })).toBe(false)
  })

  it('is false when y differs', () => {
    expect(rectsEqual(base, { x: 1, y: 99, width: 3, height: 4 })).toBe(false)
  })

  it('is false when width differs', () => {
    expect(rectsEqual(base, { x: 1, y: 2, width: 99, height: 4 })).toBe(false)
  })

  it('is false when height differs', () => {
    expect(rectsEqual(base, { x: 1, y: 2, width: 3, height: 99 })).toBe(false)
  })

  it('treats a round-tripped equal rect as a no-op (diff-skip case)', () => {
    const node: Rect = { x: 120, y: 240, width: 200, height: 120 }
    const vp: Viewport = { x: -50, y: 30, zoom: 0.75 }
    const a = roundRect(worldRectToScreen(node, vp, { x: 0, y: 84 }))
    const b = roundRect(worldRectToScreen(node, vp, { x: 0, y: 84 }))
    expect(rectsEqual(a, b)).toBe(true)
  })
})

describe('fitZoomFactor', () => {
  // A 480px-wide board makes the three presets land inside the [0.25,5] clamp at zoom 1.
  it('is nodeWorldW / presetW at camera zoom 1', () => {
    expect(fitZoomFactor(480, 390, 1)).toBeCloseTo(480 / 390, 10) // mobile  ≈ 1.231
    expect(fitZoomFactor(480, 834, 1)).toBeCloseTo(480 / 834, 10) // tablet  ≈ 0.576
    expect(fitZoomFactor(480, 1280, 1)).toBeCloseTo(480 / 1280, 10) // desktop = 0.375
  })

  it('makes the page lay out at exactly presetW (bounds.width / zoomFactor === W)', () => {
    const nodeWorldW = 480
    const W = 834
    const camZoom = 1.6
    const boundsWidth = nodeWorldW * camZoom // worldRectToScreen width
    const zf = fitZoomFactor(nodeWorldW, W, camZoom)
    expect(boundsWidth / zf).toBeCloseTo(W, 10)
  })

  it('scales linearly with camera zoom', () => {
    expect(fitZoomFactor(390, 390, 2)).toBeCloseTo(2, 10)
    expect(fitZoomFactor(390, 390, 0.5)).toBeCloseTo(0.5, 10)
  })

  it('clamps below Chromium min (0.25) at extreme zoom-out', () => {
    expect(fitZoomFactor(480, 1280, 0.1)).toBe(0.25) // raw 0.0375 → clamped
  })

  it('clamps above Chromium max (5)', () => {
    expect(fitZoomFactor(480, 100, 2)).toBe(5) // raw 9.6 → clamped
  })
})

// Bug #20: the consumer feeds `setBounds(round(rect))` (integer native px) but the OLD
// zoomFor derived the factor from the UN-rounded stage width, breaking the documented
// invariant bounds.width / zoomFactor === presetW (it drifted by the ≤0.5px rounding,
// so the responsive page laid out at e.g. 389.73 / 390.70 instead of exactly 390).
// fitZoomFactorForBounds derives the factor from the SAME rounded bounds width, so the
// invariant holds EXACTLY on the consumer path.
describe('fitZoomFactorForBounds', () => {
  it('makes the page lay out at EXACTLY presetW for an integer bounds width', () => {
    // A rounded (integer) native bounds width — what setBounds actually receives.
    const roundedBoundsWidth = 167 // e.g. round(371px stage * 0.45 camZoom)
    const presetW = 390
    const zf = fitZoomFactorForBounds(roundedBoundsWidth, presetW)
    // Exact: no sub-pixel drift (this is the property the old un-rounded path missed).
    expect(roundedBoundsWidth / zf).toBe(presetW)
  })

  it('holds the invariant across every preset for assorted integer bounds widths', () => {
    for (const presetW of [390, 834, 1280]) {
      for (const w of [100, 167, 333, 500, 999, 1500]) {
        const zf = fitZoomFactorForBounds(w, presetW)
        // Only assert the invariant in the unclamped band (clamp re-attributes it).
        if (zf > 0.25 && zf < 5) expect(w / zf).toBeCloseTo(presetW, 10)
      }
    }
  })

  it('still clamps to the Chromium [0.25, 5] zoom-factor range', () => {
    expect(fitZoomFactorForBounds(40, 1280)).toBe(0.25) // raw 0.03125 → clamped
    expect(fitZoomFactorForBounds(960, 100)).toBe(5) // raw 9.6 → clamped
  })

  it('drift vs the old un-rounded path: the old derivation misses exact presetW', () => {
    // Realistic live (zoom >= LOD) non-clamped case from the finding: a ~371px world
    // stage at camZoom 0.45 → un-rounded screen width 166.95, rounded bounds 167.
    const stageWorldW = 371
    const camZoom = 0.45
    const presetW = 390
    const unrounded = stageWorldW * camZoom // 166.95
    const roundedBoundsWidth = Math.round(unrounded) // 167
    // Old path (zoomFor used fitZoomFactor on the un-rounded stage width):
    const oldZf = fitZoomFactor(stageWorldW, presetW, camZoom)
    const oldLayoutW = roundedBoundsWidth / oldZf
    expect(oldLayoutW).not.toBe(presetW) // drifts off the exact breakpoint
    expect(Math.abs(oldLayoutW - presetW)).toBeLessThan(1) // sub-pixel (Low severity)
    // New path: exact.
    const newZf = fitZoomFactorForBounds(roundedBoundsWidth, presetW)
    expect(roundedBoundsWidth / newZf).toBe(presetW)
  })
})

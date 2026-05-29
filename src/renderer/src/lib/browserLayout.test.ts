import { describe, it, expect } from 'vitest'
import {
  TITLEBAR_H,
  URLBAR_H,
  MAX_FIT_SCALE,
  VIEWPORT_PRESETS,
  contentWellRect,
  deviceFitScale,
  deviceFrameRect,
  deviceStageRect,
  toWorldRect
} from './browserLayout'

describe('VIEWPORT_PRESETS', () => {
  it('matches DESIGN.md §7.2 dimensions + the proven trick widths {390,834,1280}', () => {
    expect(VIEWPORT_PRESETS.mobile).toMatchObject({ w: 390, h: 844, notch: true })
    expect(VIEWPORT_PRESETS.tablet).toMatchObject({ w: 834, h: 1112, notch: false })
    expect(VIEWPORT_PRESETS.desktop).toMatchObject({ w: 1280, h: 800, notch: false })
  })

  it('uses a larger radius for mobile (22) than desktop (8)', () => {
    expect(VIEWPORT_PRESETS.mobile.radius).toBe(22)
    expect(VIEWPORT_PRESETS.desktop.radius).toBe(8)
  })
})

describe('contentWellRect', () => {
  it('removes the titlebar + URL bar from the top', () => {
    const well = contentWellRect(700, 500)
    expect(well).toEqual({ x: 0, y: TITLEBAR_H + URLBAR_H, width: 700, height: 500 - 64 })
  })

  it('clamps a too-short board to a non-negative height', () => {
    const well = contentWellRect(240, 40)
    expect(well.height).toBe(0)
    expect(well.width).toBe(240)
  })
})

describe('deviceFitScale', () => {
  it('fits the preset aspect inside the gutter-inset well (height-bound for desktop)', () => {
    // 700×500 board → well 700×436, avail (700-28)×(436-28) = 672×408.
    // desktop 1280×800 → min(672/1280, 408/800, 1.1) = min(0.525, 0.51, 1.1) = 0.51
    const s = deviceFitScale(700, 500, 'desktop')
    expect(s).toBeCloseTo(408 / 800, 6)
  })

  it('caps the scale at MAX_FIT_SCALE for a small preset in a big board', () => {
    const s = deviceFitScale(4000, 4000, 'mobile')
    expect(s).toBe(MAX_FIT_SCALE)
  })

  it('returns 0 when the content well has no room', () => {
    expect(deviceFitScale(20, 20, 'desktop')).toBe(0)
  })
})

describe('deviceFrameRect', () => {
  it('centres the scaled preset box in the content well', () => {
    const f = deviceFrameRect(700, 500, 'desktop')
    const scale = deviceFitScale(700, 500, 'desktop')
    expect(f.width).toBeCloseTo(1280 * scale, 6)
    expect(f.height).toBeCloseTo(800 * scale, 6)
    // Centred horizontally within the 700-wide well.
    expect(f.x).toBeCloseTo((700 - f.width) / 2, 6)
    // Top edge below titlebar + URL bar, then centred in the remaining well.
    const well = contentWellRect(700, 500)
    expect(f.y).toBeCloseTo(well.y + (well.height - f.height) / 2, 6)
  })

  it('keeps the preset aspect ratio (no stretch)', () => {
    const f = deviceFrameRect(900, 700, 'mobile')
    expect(f.width / f.height).toBeCloseTo(390 / 844, 6)
  })
})

describe('deviceStageRect', () => {
  it('insets the frame by 1px border on every side', () => {
    const f = deviceFrameRect(700, 500, 'desktop')
    const s = deviceStageRect(700, 500, 'desktop')
    expect(s.x).toBeCloseTo(f.x + 1, 6)
    expect(s.y).toBeCloseTo(f.y + 1, 6)
    expect(s.width).toBeCloseTo(f.width - 2, 6)
    expect(s.height).toBeCloseTo(f.height - 2, 6)
  })

  it('never produces a negative size on a tiny board', () => {
    const s = deviceStageRect(240, 160, 'desktop')
    expect(s.width).toBeGreaterThanOrEqual(0)
    expect(s.height).toBeGreaterThanOrEqual(0)
  })
})

describe('toWorldRect', () => {
  it('offsets a board-local rect by the board world origin, preserving size', () => {
    const local = { x: 10, y: 20, width: 300, height: 200 }
    expect(toWorldRect(local, 1000, -500)).toEqual({
      x: 1010,
      y: -480,
      width: 300,
      height: 200
    })
  })
})

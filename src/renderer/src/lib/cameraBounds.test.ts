import { describe, it, expect } from 'vitest'
import { worldRectToScreen, roundRect, rectsEqual, type Rect, type Viewport } from './cameraBounds'

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

import { describe, it, expect } from 'vitest'
import { screenToBoard, pushBoardPoint, pointsToPairs } from './pen'

describe('screenToBoard (÷zoom mapping — the Planning gate)', () => {
  it('is the identity offset at zoom 1', () => {
    const m = { originX: 100, originY: 50, zoom: 1 }
    expect(screenToBoard({ x: 100, y: 50 }, m)).toEqual({ x: 0, y: 0 })
    expect(screenToBoard({ x: 180, y: 90 }, m)).toEqual({ x: 80, y: 40 })
  })

  it('divides the content-relative delta by zoom (strokes land under the cursor)', () => {
    // Content well top-left at (200, 120). At 2× zoom a board-local point P is
    // drawn on-screen at origin + P*2, so the inverse must divide by 2.
    const m = { originX: 200, originY: 120, zoom: 2 }
    // Screen point 200px right of the origin → 100 board-local px at 2× zoom.
    expect(screenToBoard({ x: 400, y: 120 }, m)).toEqual({ x: 100, y: 0 })
    expect(screenToBoard({ x: 200, y: 320 }, m)).toEqual({ x: 0, y: 100 })
  })

  it('zooms out the same way (÷ a fractional zoom enlarges the board delta)', () => {
    const m = { originX: 0, originY: 0, zoom: 0.5 }
    // 50 screen px at 0.5× zoom = 100 board-local px.
    expect(screenToBoard({ x: 50, y: 50 }, m)).toEqual({ x: 100, y: 100 })
  })

  it('round-trips: project a board point to screen then map back (any zoom)', () => {
    const origin = { x: 64, y: 88 }
    for (const zoom of [0.25, 0.5, 1, 1.37, 2, 2.5]) {
      for (const local of [
        { x: 0, y: 0 },
        { x: 10.5, y: 240 },
        { x: 333, y: 17 }
      ]) {
        // Forward projection the content well performs: screen = origin + local*zoom.
        const screen = { x: origin.x + local.x * zoom, y: origin.y + local.y * zoom }
        const back = screenToBoard(screen, { originX: origin.x, originY: origin.y, zoom })
        expect(back.x).toBeCloseTo(local.x, 9)
        expect(back.y).toBeCloseTo(local.y, 9)
      }
    }
  })

  it('keeps the SAME board point under the cursor regardless of zoom', () => {
    // The cursor sits at a fixed screen position; as the camera zooms, the
    // board-local point it maps to must change with 1/zoom (proves ÷zoom, not ×).
    const origin = { originX: 100, originY: 100 }
    const screen = { x: 300, y: 100 } // 200px right of origin
    expect(screenToBoard(screen, { ...origin, zoom: 1 }).x).toBe(200)
    expect(screenToBoard(screen, { ...origin, zoom: 2 }).x).toBe(100)
    expect(screenToBoard(screen, { ...origin, zoom: 0.5 }).x).toBe(400)
  })

  it('falls back to zoom 1 for a non-finite or non-positive zoom (no NaN/Infinity)', () => {
    const base = { originX: 10, originY: 10 }
    expect(screenToBoard({ x: 60, y: 10 }, { ...base, zoom: 0 })).toEqual({ x: 50, y: 0 })
    expect(screenToBoard({ x: 60, y: 10 }, { ...base, zoom: -2 })).toEqual({ x: 50, y: 0 })
    expect(screenToBoard({ x: 60, y: 10 }, { ...base, zoom: NaN })).toEqual({ x: 50, y: 0 })
    expect(screenToBoard({ x: 60, y: 10 }, { ...base, zoom: Infinity })).toEqual({ x: 50, y: 0 })
  })
})

describe('pushBoardPoint', () => {
  it('appends a flat [x, y] pair without mutating the input', () => {
    const a: number[] = [1, 2]
    const b = pushBoardPoint(a, { x: 3, y: 4 })
    expect(b).toEqual([1, 2, 3, 4])
    expect(a).toEqual([1, 2]) // unchanged
  })

  it('builds a stroke point list from empty', () => {
    let pts: number[] = []
    pts = pushBoardPoint(pts, { x: 0, y: 0 })
    pts = pushBoardPoint(pts, { x: 5, y: 9 })
    expect(pts).toEqual([0, 0, 5, 9])
  })
})

describe('pointsToPairs', () => {
  it('groups a flat list into [x, y] pairs', () => {
    expect(pointsToPairs([0, 0, 5, 9, 10, 20])).toEqual([
      [0, 0],
      [5, 9],
      [10, 20]
    ])
  })

  it('is empty for fewer than two coordinates', () => {
    expect(pointsToPairs([])).toEqual([])
    expect(pointsToPairs([3])).toEqual([])
  })

  it('drops a trailing unpaired coordinate', () => {
    expect(pointsToPairs([1, 2, 3])).toEqual([[1, 2]])
  })
})

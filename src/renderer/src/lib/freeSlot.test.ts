import { describe, it, expect } from 'vitest'
import { freeSlot, viewportCenterWorld, PLACE_GAP } from './freeSlot'
import type { Board } from './boardSchema'

const board = (x: number, y: number, w = 100, h = 100): Board =>
  ({ id: `${x}-${y}`, type: 'terminal', title: 't', x, y, w, h }) as Board

function overlaps(
  slot: { x: number; y: number },
  size: { w: number; h: number },
  b: Board
): boolean {
  return (
    slot.x < b.x + b.w + PLACE_GAP &&
    b.x < slot.x + size.w + PLACE_GAP &&
    slot.y < b.y + b.h + PLACE_GAP &&
    b.y < slot.y + size.h + PLACE_GAP
  )
}

describe('freeSlot', () => {
  it('returns the requested point when nothing overlaps', () => {
    expect(freeSlot([], { x: 50, y: 60 }, { w: 100, h: 80 })).toEqual({ x: 50, y: 60 })
  })

  it('nudges off an overlapping board into clear space (PLACE_GAP margin respected)', () => {
    const at = { x: 0, y: 0 }
    const size = { w: 100, h: 100 }
    const seeded = board(0, 0)
    const slot = freeSlot([seeded], at, size)
    expect(slot).not.toEqual(at)
    expect(overlaps(slot, size, seeded)).toBe(false)
  })

  it('is deterministic — same inputs yield the same slot', () => {
    const boards = [board(0, 0), board(200, 0)]
    const a = freeSlot(boards, { x: 0, y: 0 }, { w: 100, h: 100 })
    const b = freeSlot(boards, { x: 0, y: 0 }, { w: 100, h: 100 })
    expect(a).toEqual(b)
  })
})

describe('viewportCenterWorld (spawn anchor — off-screen-spawn fix 2026-06-18)', () => {
  const fallback = { x: 120, y: 120 }

  it('maps the screen centre to its world point under the camera transform', () => {
    // pan (100,50), zoom 2, 1000x600 window → screen-centre (500,300) → world ((500-100)/2,(300-50)/2)
    expect(viewportCenterWorld({ x: 100, y: 50, zoom: 2 }, { w: 1000, h: 600 }, fallback)).toEqual({
      x: 200,
      y: 125
    })
  })

  it('at identity (pan 0, zoom 1) the world centre is just half the window', () => {
    expect(viewportCenterWorld({ x: 0, y: 0, zoom: 1 }, { w: 1280, h: 800 }, fallback)).toEqual({
      x: 640,
      y: 400
    })
  })

  it('falls back when there is no viewport yet / a degenerate zoom', () => {
    expect(viewportCenterWorld(null, { w: 1000, h: 600 }, fallback)).toEqual(fallback)
    expect(viewportCenterWorld(undefined, { w: 1000, h: 600 }, fallback)).toEqual(fallback)
    expect(viewportCenterWorld({ x: 0, y: 0, zoom: 0 }, { w: 1000, h: 600 }, fallback)).toEqual(
      fallback
    )
  })
})

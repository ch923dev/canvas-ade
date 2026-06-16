import { describe, it, expect } from 'vitest'
import { freeSlot, PLACE_GAP } from './freeSlot'
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

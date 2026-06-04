import { describe, it, expect } from 'vitest'
import { snapOthers, boardsBounds, type BoardRect } from './boardGeometry'

const b = (id: string, x: number, y: number, w = 100, h = 80): BoardRect => ({ id, x, y, w, h })

describe('snapOthers', () => {
  it('returns every board except the excluded one, in order', () => {
    const boards = [b('a', 0, 0), b('b', 200, 0), b('c', 0, 200)]
    expect(snapOthers(boards, 'b')).toEqual([
      { x: 0, y: 0, w: 100, h: 80 },
      { x: 0, y: 200, w: 100, h: 80 }
    ])
  })

  it('strips down to {x,y,w,h} (drops id and any extra fields)', () => {
    const boards = [b('a', 5, 6, 7, 8), b('keep', 9, 9)]
    const out = snapOthers(boards, 'keep')
    expect(out).toEqual([{ x: 5, y: 6, w: 7, h: 8 }])
    expect('id' in out[0]).toBe(false)
  })

  it('returns an empty array when the excluded board is the only one', () => {
    expect(snapOthers([b('solo', 0, 0)], 'solo')).toEqual([])
  })

  it('returns a fresh array (does not alias the input)', () => {
    const boards = [b('a', 0, 0), b('x', 1, 1)]
    const out = snapOthers(boards, 'x')
    expect(out).not.toBe(boards)
    out.push({ x: 0, y: 0, w: 0, h: 0 })
    expect(boards).toHaveLength(2)
  })
})

describe('boardsBounds', () => {
  it('returns null for an empty board set', () => {
    expect(boardsBounds([])).toBeNull()
  })

  it('uses x/y/(x+w)/(y+h) for a single board', () => {
    expect(boardsBounds([b('a', 10, 20, 100, 80)])).toEqual({
      minX: 10,
      minY: 20,
      maxX: 110,
      maxY: 100
    })
  })

  it('spans the extremes across multiple boards', () => {
    const boards = [b('a', 0, 0, 100, 80), b('b', 300, 50, 100, 80), b('c', -40, 200, 100, 80)]
    expect(boardsBounds(boards)).toEqual({ minX: -40, minY: 0, maxX: 400, maxY: 280 })
  })

  it('handles all-negative coordinates', () => {
    expect(boardsBounds([b('a', -200, -200, 50, 50)])).toEqual({
      minX: -200,
      minY: -200,
      maxX: -150,
      maxY: -150
    })
  })
})

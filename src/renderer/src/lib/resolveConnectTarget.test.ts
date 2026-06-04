import { describe, it, expect } from 'vitest'
import { resolveConnectTarget } from './resolveConnectTarget'
import type { Board } from './boardSchema'

const board = (id: string, x: number, y: number, z?: number): Board => ({
  id,
  type: 'terminal',
  x,
  y,
  w: 200,
  h: 100,
  title: id,
  ...(z !== undefined ? { z } : {})
})

describe('resolveConnectTarget', () => {
  const a = board('a', 0, 0) // covers (0,0)..(200,100)
  const b = board('b', 400, 0) // covers (400,0)..(600,100)

  it('returns the board whose rect contains the flow point', () => {
    expect(resolveConnectTarget([a, b], 'a', { x: 450, y: 50 })).toBe('b')
  })

  it('returns null when the point is over empty canvas', () => {
    expect(resolveConnectTarget([a, b], 'a', { x: 1000, y: 1000 })).toBeNull()
  })

  it('never resolves to the source board (no self-link), even when the point is inside it', () => {
    expect(resolveConnectTarget([a, b], 'a', { x: 50, y: 50 })).toBeNull()
  })

  it('hits on the rect boundary (inclusive edges)', () => {
    expect(resolveConnectTarget([a, b], 'a', { x: 600, y: 100 })).toBe('b')
    expect(resolveConnectTarget([a, b], 'a', { x: 400, y: 0 })).toBe('b')
  })

  it('picks the topmost board when rects overlap (higher z wins)', () => {
    const lo = board('lo', 0, 0, 1)
    const hi = board('hi', 50, 20, 5) // overlaps lo; point (60,30) is in both
    expect(resolveConnectTarget([lo, hi], 'src', { x: 60, y: 30 })).toBe('hi')
  })

  it('breaks a z tie by later array order (render order = on top)', () => {
    const first = board('first', 0, 0)
    const second = board('second', 0, 0) // identical rect, no z → later one is on top
    expect(resolveConnectTarget([first, second], 'src', { x: 10, y: 10 })).toBe('second')
  })

  it('returns null for an empty board list', () => {
    expect(resolveConnectTarget([], 'a', { x: 0, y: 0 })).toBeNull()
  })
})

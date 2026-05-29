import { describe, it, expect } from 'vitest'
import { arrowPath, strokeToPath } from './svgPaths'
import type { ArrowElement } from '../../../lib/boardSchema'

const arrow = (x: number, y: number, x2: number, y2: number): ArrowElement => ({
  id: 'a',
  kind: 'arrow',
  x,
  y,
  x2,
  y2
})

describe('arrowPath', () => {
  it('starts at the start point and ends at the end point', () => {
    const d = arrowPath(arrow(10, 20, 110, 80))
    expect(d.startsWith('M 10 20 C')).toBe(true)
    expect(d.trim().endsWith('110 80')).toBe(true)
  })

  it('emits a single cubic bezier command', () => {
    const d = arrowPath(arrow(0, 0, 50, 50))
    expect((d.match(/C/g) ?? []).length).toBe(1)
  })
})

describe('strokeToPath (perfect-freehand → fill path)', () => {
  it('is empty for an empty / single-coordinate point list', () => {
    expect(strokeToPath([])).toBe('')
    expect(strokeToPath([5])).toBe('')
  })

  it('produces a closed fill path for a real stroke', () => {
    // A short diagonal scribble in board-local coords.
    const pts = [0, 0, 5, 4, 12, 9, 20, 11, 30, 10]
    const d = strokeToPath(pts)
    expect(d.startsWith('M ')).toBe(true)
    expect(d.endsWith(' Z')).toBe(true)
    expect(d).toContain(' L ')
  })

  it('is deterministic for the same input', () => {
    const pts = [0, 0, 10, 10, 20, 5]
    expect(strokeToPath(pts)).toBe(strokeToPath(pts))
  })
})

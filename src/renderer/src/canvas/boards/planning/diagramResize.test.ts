import { describe, it, expect } from 'vitest'
import { resizeFromDrag, DIAGRAM_MIN_W, DIAGRAM_MIN_H } from './diagramResize'

describe('resizeFromDrag', () => {
  const start = { w: 280, h: 200 }

  it('adds the screen delta ÷ boardScale to the start size (zoom-stable)', () => {
    // At 2× zoom, a 100px screen drag is only 50 board-local px.
    expect(resizeFromDrag(start, { dx: 100, dy: 60 }, 2)).toEqual({ w: 330, h: 230 })
    // At 0.5× zoom, a 50px screen drag is 100 board-local px.
    expect(resizeFromDrag(start, { dx: 50, dy: 50 }, 0.5)).toEqual({ w: 380, h: 300 })
  })

  it('floors at the minimum size on a shrink past the floor', () => {
    expect(resizeFromDrag(start, { dx: -1000, dy: -1000 }, 1)).toEqual({
      w: DIAGRAM_MIN_W,
      h: DIAGRAM_MIN_H
    })
  })

  it('treats a non-finite or non-positive boardScale as 1:1 (no NaN / no blow-up)', () => {
    expect(resizeFromDrag(start, { dx: 20, dy: 20 }, 0)).toEqual({ w: 300, h: 220 })
    expect(resizeFromDrag(start, { dx: 20, dy: 20 }, NaN)).toEqual({ w: 300, h: 220 })
  })

  it('rounds to whole px', () => {
    expect(resizeFromDrag(start, { dx: 33, dy: 33 }, 3)).toEqual({ w: 291, h: 211 })
  })
})

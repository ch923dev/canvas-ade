import { describe, it, expect } from 'vitest'
import { Position } from '@xyflow/react'
import { edgePositions } from './floatingPath'

// Bug M4: the bezier's source/target Position pair must follow the boards' geometry
// (the dominant axis between the two centers), not a hardcoded Right→Left, or the
// control arms fishhook/S-curve when the browser board is left/above/below the
// terminal. edgePositions derives the pair; here we drive each cardinal relationship.
describe('edgePositions', () => {
  const source = { x: 0, y: 0 }

  it('browser to the right → Right/Left', () => {
    expect(edgePositions(source, { x: 400, y: 0 })).toEqual({
      sourcePosition: Position.Right,
      targetPosition: Position.Left
    })
  })

  it('browser to the left → Left/Right', () => {
    expect(edgePositions(source, { x: -400, y: 0 })).toEqual({
      sourcePosition: Position.Left,
      targetPosition: Position.Right
    })
  })

  it('browser above → Top/Bottom', () => {
    expect(edgePositions(source, { x: 0, y: -400 })).toEqual({
      sourcePosition: Position.Top,
      targetPosition: Position.Bottom
    })
  })

  it('browser below → Bottom/Top', () => {
    expect(edgePositions(source, { x: 0, y: 400 })).toEqual({
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    })
  })

  it('picks the dominant axis when both deltas are non-zero', () => {
    // Mostly horizontal (|dx| > |dy|), target to the right and slightly below.
    expect(edgePositions(source, { x: 400, y: 50 })).toEqual({
      sourcePosition: Position.Right,
      targetPosition: Position.Left
    })
    // Mostly vertical (|dy| > |dx|), target below and slightly left.
    expect(edgePositions(source, { x: -50, y: 400 })).toEqual({
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    })
  })
})

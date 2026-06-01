import { describe, it, expect } from 'vitest'
import { eraseHitTest, ERASE_TOL, TEXT_HIT } from './erase'
import { makeNote, makeChecklist, makeArrow, makeStroke, makeText } from './elements'

describe('eraseHitTest — cards (rect + tolerance)', () => {
  it('hits a note inside its rect and within the tolerance band', () => {
    const note = makeNote('n', { x: 100, y: 100 }, 0) // w156 h96, x=22 y=80
    expect(eraseHitTest(note, { x: note.x + 10, y: note.y + 10 })).toBe(true)
    // just outside, but within ERASE_TOL → still a hit
    expect(eraseHitTest(note, { x: note.x - (ERASE_TOL - 1), y: note.y + 10 })).toBe(true)
    // well outside → miss
    expect(eraseHitTest(note, { x: note.x - 100, y: note.y })).toBe(false)
  })

  it('uses a nominal height for a checklist (schema h is 0)', () => {
    const cl = makeChecklist('cl', 'i0', { x: 200, y: 200 }) // h:0 in schema
    // a point a couple rows below the anchor must still hit the rendered card
    expect(eraseHitTest(cl, { x: cl.x + 10, y: cl.y + 40 })).toBe(true)
  })

  it('uses a nominal box for auto-sized text', () => {
    const t = makeText('t', { x: 50, y: 50 })
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w / 2, y: 50 + TEXT_HIT.h / 2 })).toBe(true)
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w + 50, y: 50 })).toBe(false)
  })
})

describe('eraseHitTest — vectors (distance)', () => {
  it('hits near an arrow and misses far from it', () => {
    const a = { ...makeArrow('a', { x: 0, y: 0 }), x2: 100, y2: 0 }
    expect(eraseHitTest(a, { x: 50, y: 2 })).toBe(true) // on the line
    expect(eraseHitTest(a, { x: 50, y: 60 })).toBe(false) // far below
  })

  it('hits near a stroke polyline and misses far from it', () => {
    const s = makeStroke('s', [0, 0, 50, 0, 100, 0])
    expect(eraseHitTest(s, { x: 25, y: 3 })).toBe(true)
    expect(eraseHitTest(s, { x: 25, y: 40 })).toBe(false)
  })

  it('handles a single-point (dot) stroke', () => {
    const s = makeStroke('s', [10, 10])
    expect(eraseHitTest(s, { x: 12, y: 12 })).toBe(true)
    expect(eraseHitTest(s, { x: 40, y: 40 })).toBe(false)
  })
})

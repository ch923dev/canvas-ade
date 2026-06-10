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

  it('uses a nominal box for auto-sized text when no measured map is provided', () => {
    const t = makeText('t', { x: 50, y: 50 })
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w / 2, y: 50 + TEXT_HIT.h / 2 })).toBe(true)
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w + 50, y: 50 })).toBe(false)
  })

  it('BUG-015: text hit uses live measured dimensions when a measured map is provided', () => {
    // A wide XL area text: measured w=500, h=80 (XL multi-line).
    // Without the fix the hit box is the stale 160x24 nominal — most of the element is un-erasable.
    const t = makeText('t', { x: 50, y: 50 })
    const measured = new Map([['t', { w: 500, h: 80 }]])
    // Point inside the measured box but outside the nominal box
    expect(eraseHitTest(t, { x: 50 + 300, y: 50 + 50 }, undefined, measured)).toBe(true)
    // Point outside both boxes
    expect(eraseHitTest(t, { x: 50 + 600, y: 50 }, undefined, measured)).toBe(false)
    // Nominal box still works when no measurement
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w / 2, y: 50 + TEXT_HIT.h / 2 })).toBe(true)
  })

  it('BUG-015: text hit phantom band: a SHORT text does not erase at wide measured box extents when measurement is provided', () => {
    // A short text (measured w=40, h=16). The old 160x24 nominal box created a phantom 128px band.
    const t = makeText('t', { x: 50, y: 50 })
    const measured = new Map([['t', { w: 40, h: 16 }]])
    // Point inside the measured box
    expect(eraseHitTest(t, { x: 60, y: 58 }, undefined, measured)).toBe(true)
    // Point outside the measured box but inside the old 160x24 nominal (phantom band)
    expect(eraseHitTest(t, { x: 50 + 130, y: 50 + 8 }, undefined, measured)).toBe(false)
  })

  it('BUG-015: note hit uses measured height when provided', () => {
    // A one-line note renders ~34px tall; el.h is 96 (phantom band below).
    const n = makeNote('n', { x: 100, y: 100 }, 0) // h:96 in schema, but rendered ~34px
    const measured = new Map([['n', { w: 156, h: 34 }]])
    // Point inside measured height
    expect(eraseHitTest(n, { x: 180, y: 120 }, undefined, measured)).toBe(true)
    // Point below measured height but inside schema h=96 (old phantom band)
    expect(eraseHitTest(n, { x: 180, y: 160 }, undefined, measured)).toBe(false)
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

  it('treats the tolerance band as inclusive (<= tol)', () => {
    const s = makeStroke('s', [0, 0, 100, 0]) // horizontal segment on y=0
    // exactly ERASE_TOL away → inclusive hit
    expect(eraseHitTest(s, { x: 50, y: ERASE_TOL })).toBe(true)
    // just beyond the band → miss
    expect(eraseHitTest(s, { x: 50, y: ERASE_TOL + 1 })).toBe(false)
  })

  it('hits a curved (diagonal) arrow on its sampled bezier', () => {
    // (0,0)->(100,100): the bowed cubic passes through (50,50) at t=0.5
    const a = { ...makeArrow('a', { x: 0, y: 0 }), x2: 100, y2: 100 }
    expect(eraseHitTest(a, { x: 50, y: 50 })).toBe(true)
    expect(eraseHitTest(a, { x: 50, y: 95 })).toBe(false) // clearly off the curve
  })
})

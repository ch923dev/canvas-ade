import { describe, it, expect } from 'vitest'
import {
  elementBBox,
  eraseHitTest,
  nominalChecklistHeight,
  TEXT_NOMINAL,
  TEXT_HIT,
  ERASE_TOL
} from './elementRegistry'
import { makeNote, makeChecklist, makeText, makeArrow, makeStroke, makeImage } from './elements'
import * as fromElements from './elements'
import * as fromErase from './erase'

/**
 * S3 — the unified geometry rail. These exercise `elementBBox` + `eraseHitTest` through their
 * canonical module (`./elementRegistry`), assert the per-kind parity the pre-refactor switches
 * had, pin the deliberately-preserved TEXT nominal-size drift, and prove `./elements` + `./erase`
 * re-export the SAME symbols (so the existing suites that import from those paths still cover the
 * rail). The dedicated `elements.test.ts` / `erase.test.ts` suites remain the exhaustive ones.
 */
describe('elementRegistry — unified geometry rail (S3)', () => {
  describe('elementBBox dispatches per kind', () => {
    it('note: positive measured height wins, else schema h', () => {
      const n = makeNote('n', { x: 10, y: 20 }, 0)
      expect(elementBBox(n)).toEqual({ x: n.x, y: n.y, w: n.w, h: n.h })
      expect(elementBBox(n, { w: n.w, h: 34 }).h).toBe(34)
      expect(elementBBox(n, { w: n.w, h: 0 }).h).toBe(n.h) // zero measured → fall back to el.h
    })
    it('text: TEXT_NOMINAL fallback, measured override', () => {
      const t = makeText('t', { x: 10, y: 20 })
      expect(elementBBox(t)).toEqual({ x: 10, y: 20, w: TEXT_NOMINAL.w, h: TEXT_NOMINAL.h })
      expect(elementBBox(t, { w: 80, h: 40 })).toEqual({ x: 10, y: 20, w: 80, h: 40 })
    })
    it('checklist: nominal height from item count', () => {
      const cl = makeChecklist('cl', 'i0', { x: 5, y: 6 })
      expect(elementBBox(cl)).toEqual({ x: cl.x, y: cl.y, w: cl.w, h: nominalChecklistHeight(1) })
    })
    it('arrow: endpoint extent box', () => {
      const a = { ...makeArrow('a', { x: 10, y: 50 }), x2: 30, y2: 90 }
      expect(elementBBox(a)).toEqual({ x: 10, y: 50, w: 20, h: 40 })
    })
    it('stroke: point extent box', () => {
      const s = makeStroke('s', [5, 5, 25, 35])
      expect(elementBBox(s)).toEqual({ x: 5, y: 5, w: 20, h: 30 })
    })
    it('image: explicit w/h', () => {
      const im = makeImage('im', { x: 5, y: 6 }, 'asset', 30, 40)
      expect(elementBBox(im)).toEqual({ x: im.x, y: im.y, w: 30, h: 40 })
    })
  })

  describe('eraseHitTest dispatches per kind', () => {
    it('hits a note rect within tolerance, misses far away', () => {
      const n = makeNote('n', { x: 100, y: 100 }, 0)
      expect(eraseHitTest(n, { x: n.x + 10, y: n.y + 10 })).toBe(true)
      expect(eraseHitTest(n, { x: n.x - 100, y: n.y })).toBe(false)
    })
    it('uses TEXT_HIT for un-measured text', () => {
      const t = makeText('t', { x: 50, y: 50 })
      expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w / 2, y: 50 + TEXT_HIT.h / 2 })).toBe(true)
      expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w + 50, y: 50 })).toBe(false)
    })
    it('arrow distance test treats the tolerance band as inclusive', () => {
      const a = { ...makeArrow('a', { x: 0, y: 0 }), x2: 100, y2: 0 }
      expect(eraseHitTest(a, { x: 50, y: ERASE_TOL })).toBe(true)
      expect(eraseHitTest(a, { x: 50, y: ERASE_TOL + 1 })).toBe(false)
    })
  })

  describe('drift guard — text nominal sizes are intentionally distinct', () => {
    // The bbox nominal (TEXT_NOMINAL) and the eraser-hit nominal (TEXT_HIT) DIFFER on purpose
    // (the eraser is more forgiving on un-measured text). This guard fails loudly if a future
    // change silently collapses them — reconciling the two is a behavior change that needs its
    // own UX review, not an accidental edit during a refactor.
    it('TEXT_HIT is larger than TEXT_NOMINAL (preserved pre-S3 behavior)', () => {
      expect(TEXT_NOMINAL).toEqual({ w: 120, h: 22 })
      expect(TEXT_HIT).toEqual({ w: 160, h: 24 })
      expect(TEXT_HIT.w).toBeGreaterThan(TEXT_NOMINAL.w)
      expect(TEXT_HIT.h).toBeGreaterThan(TEXT_NOMINAL.h)
    })
  })

  describe('re-export wiring — `./elements` + `./erase` expose the rail symbols', () => {
    it('elements.elementBBox / nominalChecklistHeight / TEXT_NOMINAL are the rail symbols', () => {
      expect(fromElements.elementBBox).toBe(elementBBox)
      expect(fromElements.nominalChecklistHeight).toBe(nominalChecklistHeight)
      expect(fromElements.TEXT_NOMINAL).toBe(TEXT_NOMINAL)
    })
    it('erase.eraseHitTest / ERASE_TOL / TEXT_HIT are the rail symbols', () => {
      expect(fromErase.eraseHitTest).toBe(eraseHitTest)
      expect(fromErase.ERASE_TOL).toBe(ERASE_TOL)
      expect(fromErase.TEXT_HIT).toBe(TEXT_HIT)
    })
  })
})

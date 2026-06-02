import { describe, it, expect } from 'vitest'
import { alignElements, distributeElements } from './align'
import type { PlanningElement } from '../../../lib/boardSchema'

const note = (id: string, x: number, y: number, w = 100, h = 60): PlanningElement =>
  ({ id, kind: 'note', x, y, w, h, tint: 'yellow', text: '' }) as PlanningElement

const byId = (els: PlanningElement[], id: string): PlanningElement => els.find((e) => e.id === id)!

describe('alignElements', () => {
  const els = [note('a', 0, 0), note('b', 50, 100), note('c', 200, 30)]

  it('left aligns every selected element to the min-left', () => {
    const out = alignElements(els, ['a', 'b', 'c'], 'left')
    expect(byId(out, 'a').x).toBe(0)
    expect(byId(out, 'b').x).toBe(0)
    expect(byId(out, 'c').x).toBe(0)
  })

  it('right aligns to the max-right edge', () => {
    const out = alignElements(els, ['a', 'b', 'c'], 'right')
    // max right edge = c: 200 + 100 = 300 → each x = 300 - w(100) = 200
    expect(byId(out, 'a').x).toBe(200)
    expect(byId(out, 'b').x).toBe(200)
  })

  it('top aligns y, leaving x untouched', () => {
    const out = alignElements(els, ['a', 'b', 'c'], 'top')
    expect(byId(out, 'b').y).toBe(0)
    expect(byId(out, 'b').x).toBe(50) // x unchanged for a vertical-edge align
  })

  it('is a no-op for fewer than 2 selected', () => {
    expect(alignElements(els, ['a'], 'left')).toBe(els)
  })

  it('aligns an arrow by its bbox, not its raw endpoints', () => {
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 300, y: 0, x2: 360, y2: 40 }
    const out = alignElements([note('a', 0, 0), arrow], ['a', 'ar'], 'left')
    // arrow bbox left = 300; union left = 0 → shift arrow x by -300
    const a2 = byId(out, 'ar')
    if (a2.kind !== 'arrow') throw new Error('arrow')
    expect(a2.x).toBe(0)
    expect(a2.x2).toBe(60)
  })
})

describe('distributeElements', () => {
  it('equalizes horizontal gaps, pinning the endpoints', () => {
    // three 100-wide notes at x = 0, 130, 400 → span 0..500 (500), sizes 300,
    // gap = (500 - 300) / 2 = 100 → middle box left = 0 + 100 + 100 = 200
    const els = [note('a', 0, 0), note('m', 130, 0), note('b', 400, 0)]
    const out = distributeElements(els, ['a', 'm', 'b'], 'h')
    expect(byId(out, 'a').x).toBe(0) // endpoint pinned
    expect(byId(out, 'b').x).toBe(400) // endpoint pinned
    expect(byId(out, 'm').x).toBe(200)
  })

  it('is a no-op for fewer than 3 selected', () => {
    const els = [note('a', 0, 0), note('b', 100, 0)]
    expect(distributeElements(els, ['a', 'b'], 'h')).toBe(els)
  })
})

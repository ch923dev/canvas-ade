import { describe, it, expect } from 'vitest'
import { alignElements, distributeElements } from './align'
import type { NoteElement } from '../../../lib/boardSchema'

const note = (id: string, x: number, y: number, locked = false): NoteElement => ({
  id, kind: 'note', x, y, w: 100, h: 50, tint: 'yellow', text: '', ...(locked ? { locked } : {})
})

describe('alignElements', () => {
  it('aligns left edges to the minimum left', () => {
    const els = [note('a', 40, 0), note('b', 100, 80), note('c', 70, 160)]
    const out = alignElements(els, ['a', 'b', 'c'], 'left')
    expect(out.map((e) => e.x)).toEqual([40, 40, 40])
  })

  it('aligns horizontal centers to the union center', () => {
    const els = [note('a', 0, 0), note('b', 100, 80)]
    const out = alignElements(els, ['a', 'b'], 'centerX')
    expect(out.map((e) => e.x)).toEqual([50, 50])
  })

  it('aligns top edges to the minimum top', () => {
    const els = [note('a', 0, 30), note('b', 0, 90)]
    const out = alignElements(els, ['a', 'b'], 'top')
    expect(out.map((e) => e.y)).toEqual([30, 30])
  })

  it('aligns the unlocked elements and leaves locked ones in place', () => {
    // a,b unlocked at differing x; c locked. align-left → a,b move to min unlocked left (20); c stays.
    const els = [note('a', 20, 0), note('b', 90, 60), note('c', 200, 120, true)]
    const out = alignElements(els, ['a', 'b', 'c'], 'left')
    expect(out.find((e) => e.id === 'a')!.x).toBe(20)
    expect(out.find((e) => e.id === 'b')!.x).toBe(20) // moved to align with a
    expect(out.find((e) => e.id === 'c')!.x).toBe(200) // locked, untouched
  })

  it('is a no-op for fewer than 2 movable elements', () => {
    const els = [note('a', 40, 0)]
    expect(alignElements(els, ['a'], 'left')).toBe(els)
  })

  it('returns the same array reference when already aligned (no phantom undo step)', () => {
    const els = [note('a', 40, 0), note('b', 40, 80)] // both left=40 already
    expect(alignElements(els, ['a', 'b'], 'left')).toBe(els)
  })
})

describe('distributeElements', () => {
  it('spaces 3 elements at equal horizontal center gaps (ends pinned)', () => {
    const els = [note('a', 0, 0), note('b', 100, 0), note('c', 300, 0)]
    const out = distributeElements(els, ['a', 'b', 'c'], 'h')
    const x = (id: string): number => out.find((e) => e.id === id)!.x
    expect(x('a')).toBe(0)
    expect(x('c')).toBe(300)
    expect(x('b')).toBe(150)
  })

  it('is a no-op for fewer than 3 movable elements', () => {
    const els = [note('a', 0, 0), note('b', 100, 0)]
    expect(distributeElements(els, ['a', 'b'], 'h')).toBe(els)
  })

  it('ignores locked elements when counting movable', () => {
    const els = [note('a', 0, 0), note('b', 100, 0), note('c', 300, 0, true)]
    expect(distributeElements(els, ['a', 'b', 'c'], 'h')).toBe(els)
  })

  it('returns the same array reference when already evenly distributed', () => {
    // centers: a=50, b=200, c=350 → gap=150; b target = 50+150=200 → delta 0
    const els = [note('a', 0, 0), note('b', 150, 0), note('c', 300, 0)]
    expect(distributeElements(els, ['a', 'b', 'c'], 'h')).toBe(els)
  })
})

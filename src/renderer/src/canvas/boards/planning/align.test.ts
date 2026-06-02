import { describe, it, expect } from 'vitest'
import { alignElements } from './align'
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
})

/**
 * summarizeSelection (P4) — the pure Element-section gating: which per-kind controls a selection
 * surfaces, and the common typography across a homogeneous text selection. Decision 3 (homogeneous →
 * per-kind; mixed → shared-only) lives here, so it is pinned here.
 *
 * globals: false — import vitest helpers explicitly.
 */
import { describe, expect, it } from 'vitest'
import type { PlanningElement, TextElement } from '../../../../lib/boardSchema'
import { makeArrow, makeNote, makeText } from '../elements'
import { summarizeSelection } from './elementModel'

const ids = (...xs: string[]): Set<string> => new Set(xs)
const text = (id: string, over: Partial<TextElement> = {}): TextElement => ({
  ...makeText(id, { x: 0, y: 0 }),
  ...over
})

describe('summarizeSelection', () => {
  it('reports an empty selection', () => {
    const s = summarizeSelection([], ids())
    expect(s.count).toBe(0)
    expect(s.kind).toBeNull()
    expect(s.typography).toBeNull()
    expect(s.mixed).toBe(false)
  })

  it('a single note → homogeneous note, no typography', () => {
    const note = makeNote('n1', { x: 0, y: 0 }, 0)
    const s = summarizeSelection([note], ids('n1'))
    expect(s.count).toBe(1)
    expect(s.kind).toBe('note')
    expect(s.isAllNotes).toBe(true)
    expect(s.isAllText).toBe(false)
    expect(s.kindLabel).toBe('note')
    expect(s.typography).toBeNull()
  })

  it('a single text → homogeneous text with default tokens', () => {
    const s = summarizeSelection([text('t1')], ids('t1'))
    expect(s.kind).toBe('text')
    expect(s.isAllText).toBe(true)
    // Un-styled text reports the pre-typography defaults (never null for a homogeneous selection).
    expect(s.typography).toEqual({
      fontFamily: 'sans',
      fontSize: 'M',
      align: 'left',
      color: 'default',
      bold: false
    })
  })

  it('multi text sharing tokens → those tokens are the common values', () => {
    const a = text('a', { fontFamily: 'mono', fontSize: 'L', bold: true })
    const b = text('b', { fontFamily: 'mono', fontSize: 'L', bold: true })
    const s = summarizeSelection([a, b], ids('a', 'b'))
    expect(s.count).toBe(2)
    expect(s.kind).toBe('text')
    expect(s.typography).toMatchObject({ fontFamily: 'mono', fontSize: 'L', bold: true })
  })

  it('multi text disagreeing on a token → that attribute is null (indeterminate)', () => {
    const a = text('a', { fontSize: 'S', color: 'accent' })
    const b = text('b', { fontSize: 'XL', color: 'accent' })
    const s = summarizeSelection([a, b], ids('a', 'b'))
    expect(s.typography?.fontSize).toBeNull() // disagree
    expect(s.typography?.color).toBe('accent') // agree
  })

  it('bold is common only when EVERY text is bold', () => {
    const a = text('a', { bold: true })
    const b = text('b', { bold: false })
    expect(summarizeSelection([a, b], ids('a', 'b')).typography?.bold).toBe(false)
    const c = text('c', { bold: true })
    expect(summarizeSelection([a, c], ids('a', 'c')).typography?.bold).toBe(true)
  })

  it('mixed kinds → mixed, no per-kind controls', () => {
    const note = makeNote('n1', { x: 0, y: 0 }, 0)
    const t = text('t1')
    const arrow = makeArrow('r1', { x: 0, y: 0 })
    const s = summarizeSelection([note, t, arrow] as PlanningElement[], ids('n1', 't1', 'r1'))
    expect(s.count).toBe(3)
    expect(s.mixed).toBe(true)
    expect(s.kind).toBe('mixed')
    expect(s.kindLabel).toBe('mixed')
    expect(s.isAllNotes).toBe(false)
    expect(s.isAllText).toBe(false)
    expect(s.typography).toBeNull()
  })

  it('ignores ids that are not in the element list', () => {
    const note = makeNote('n1', { x: 0, y: 0 }, 0)
    const s = summarizeSelection([note], ids('n1', 'ghost'))
    expect(s.count).toBe(1)
    expect(s.ids).toEqual(['n1'])
  })
})

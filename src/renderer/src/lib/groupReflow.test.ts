import { describe, it, expect } from 'vitest'
import { packGroupMembers, groupBoxAt } from './groupReflow'
import { TIDY_GAP } from './tidyLayout'
import type { TidyBoard } from './tidyLayout'

describe('packGroupMembers', () => {
  it('packs two far-apart boards into an adjacent, non-overlapping cluster at the original top-left', () => {
    // Two planning boards 1000px apart on x. Smart packs same-type boards into one row.
    const members: TidyBoard[] = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100, type: 'planning' },
      { id: 'b', x: 1000, y: 0, w: 100, h: 100, type: 'planning' }
    ]
    const out = packGroupMembers(members)
    expect(out).toHaveLength(2)
    const byId = new Map(out.map((p) => [p.id, p]))
    const a = byId.get('a')!
    const b = byId.get('b')!
    // Anchored at the original top-left (min x/y preserved).
    expect(Math.min(a.x, b.x)).toBe(0)
    expect(Math.min(a.y, b.y)).toBe(0)
    // Adjacent: the right neighbour starts exactly one tidy gap past the left one's right edge,
    // i.e. the gap collapsed from the original 1000 distance to TIDY_GAP (28), non-overlapping.
    const [left, right] = a.x <= b.x ? [a, b] : [b, a]
    expect(right.x - (left.x + 100)).toBe(TIDY_GAP)
  })

  it('returns [] for a single member (nothing to pack)', () => {
    expect(packGroupMembers([{ id: 'a', x: 5, y: 5, w: 100, h: 100, type: 'planning' }])).toEqual(
      []
    )
  })
})

describe('groupBoxAt', () => {
  const boxes = [
    { id: 'g1', x: 0, y: 0, w: 100, h: 100, depth: 0 },
    { id: 'g2', x: 200, y: 200, w: 100, h: 100, depth: 0 }
  ]

  it('returns the id of the box a point falls inside', () => {
    expect(groupBoxAt(boxes, { x: 50, y: 50 })).toBe('g1')
    expect(groupBoxAt(boxes, { x: 250, y: 250 })).toBe('g2')
  })

  it('returns null for a point outside every box', () => {
    expect(groupBoxAt(boxes, { x: 150, y: 150 })).toBeNull()
  })

  it('prefers the deeper (nested) box when boxes overlap at different depths', () => {
    const nested = [
      { id: 'outer', x: 0, y: 0, w: 200, h: 200, depth: 0 },
      { id: 'inner', x: 40, y: 40, w: 100, h: 100, depth: 1 }
    ]
    // A point inside BOTH → the deeper (inner) id wins.
    expect(groupBoxAt(nested, { x: 60, y: 60 })).toBe('inner')
    // A point inside only the outer box → the outer id.
    expect(groupBoxAt(nested, { x: 10, y: 10 })).toBe('outer')
  })

  it('skips a box listed in `exclude`', () => {
    expect(groupBoxAt(boxes, { x: 50, y: 50 }, new Set(['g1']))).toBeNull()
  })
})

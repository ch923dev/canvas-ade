import { describe, it, expect } from 'vitest'
import { computeGroupBoxes, groupMemberRectKey, groupFitMaxZoom } from './groupBoxes'
import type { Board, NamedGroup } from './boardSchema'
import type { BoardRect } from './boardGeometry'

const boards: BoardRect[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 100 },
  { id: 'b', x: 200, y: 0, w: 100, h: 100 },
  { id: 'c', x: 0, y: 200, w: 100, h: 100 }
]

describe('computeGroupBoxes', () => {
  it('frames a group around its members minus the base inset (pad expands the box outward)', () => {
    const groups: NamedGroup[] = [{ id: 'g1', name: 'Auth', boardIds: ['a', 'b'] }]
    const [box] = computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })
    expect(box).toMatchObject({ id: 'g1', name: 'Auth', depth: 0 })
    expect(box.x).toBe(-16)
    expect(box.y).toBe(-16)
    expect(box.w).toBe(300 + 32)
    expect(box.h).toBe(100 + 32)
  })

  it('skips an empty group (no members → no box)', () => {
    const groups: NamedGroup[] = [{ id: 'g1', name: 'Empty', boardIds: [] }]
    expect(computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })).toEqual([])
  })

  it('skips a group whose members are all missing', () => {
    const groups: NamedGroup[] = [{ id: 'g1', name: 'Ghosts', boardIds: ['zzz'] }]
    expect(computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })).toEqual([])
  })

  it('insets a fully-contained (nested) group by its depth so overlapping boxes are concentric', () => {
    const groups: NamedGroup[] = [
      { id: 'outer', name: 'Outer', boardIds: ['a', 'b', 'c'] },
      { id: 'inner', name: 'Inner', boardIds: ['a', 'b'] }
    ]
    const boxes = computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })
    const outer = boxes.find((x) => x.id === 'outer')!
    const inner = boxes.find((x) => x.id === 'inner')!
    expect(outer.depth).toBe(0)
    expect(inner.depth).toBe(1)
    expect(inner.x).toBeGreaterThan(outer.x)
  })

  it('nests two identical-bounds groups concentrically (tie-break by id, not exact overlap)', () => {
    // Same member set → identical bounds → mutually contained. Without a tie-break both
    // would land at depth 1 and draw on top of each other; the lower id stays outer.
    const groups: NamedGroup[] = [
      { id: 'zeta', name: 'Zeta', boardIds: ['a', 'b'] },
      { id: 'alpha', name: 'Alpha', boardIds: ['a', 'b'] }
    ]
    const boxes = computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })
    const alpha = boxes.find((x) => x.id === 'alpha')!
    const zeta = boxes.find((x) => x.id === 'zeta')!
    expect(alpha.depth).toBe(0) // 'alpha' < 'zeta' → outer
    expect(zeta.depth).toBe(1) // nests inside
    expect(zeta.x).toBeGreaterThan(alpha.x)
  })
})

describe('groupMemberRectKey (GROUP-07)', () => {
  const groups: NamedGroup[] = [
    { id: 'g1', name: 'Auth', boardIds: ['a', 'b'] },
    { id: 'g2', name: 'Infra', boardIds: ['c'] }
  ]
  const withMoved = (id: string, dx: number): BoardRect[] =>
    boards.map((b) => (b.id === id ? { ...b, x: b.x + dx } : b))

  it('is empty when there are no groups (layer renders nothing, never recomputes)', () => {
    expect(groupMemberRectKey([], boards)).toBe('')
  })

  it('is STABLE when an ungrouped board moves (no member rect changed)', () => {
    // boards a/b/c are all members above; add an ungrouped board 'u' and move it.
    const withU = [...boards, { id: 'u', x: 999, y: 999, w: 50, h: 50 }]
    const base = groupMemberRectKey(groups, withU)
    const movedU = withU.map((b) => (b.id === 'u' ? { ...b, x: 0 } : b))
    expect(groupMemberRectKey(groups, movedU)).toBe(base)
  })

  it('CHANGES when a grouped board moves', () => {
    const base = groupMemberRectKey(groups, boards)
    expect(groupMemberRectKey(groups, withMoved('a', 10))).not.toBe(base)
  })

  it('CHANGES on a group rename (so the tab label can never go stale)', () => {
    const base = groupMemberRectKey(groups, boards)
    const renamed = groups.map((g) => (g.id === 'g1' ? { ...g, name: 'Renamed' } : g))
    expect(groupMemberRectKey(renamed, boards)).not.toBe(base)
  })

  it('CHANGES on a membership change', () => {
    const base = groupMemberRectKey(groups, boards)
    const added = groups.map((g) => (g.id === 'g2' ? { ...g, boardIds: ['c', 'a'] } : g))
    expect(groupMemberRectKey(added, boards)).not.toBe(base)
  })
})

describe('groupFitMaxZoom', () => {
  const mk = (id: string, type: Board['type']): Board =>
    ({ id, type, x: 0, y: 0, w: 300, h: 200, title: 't' }) as Board

  it('caps at 1 when any member is terminal or browser (raster)', () => {
    expect(groupFitMaxZoom([mk('a', 'planning'), mk('b', 'terminal')], 2.5)).toBe(1)
    expect(groupFitMaxZoom([mk('a', 'browser')], 2.5)).toBe(1)
  })
  it('returns the vector cap when all members are planning', () => {
    expect(groupFitMaxZoom([mk('a', 'planning'), mk('b', 'planning')], 2.5)).toBe(2.5)
  })
})

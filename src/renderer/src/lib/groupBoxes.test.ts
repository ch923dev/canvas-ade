import { describe, it, expect } from 'vitest'
import { computeGroupBoxes } from './groupBoxes'
import type { NamedGroup } from './boardSchema'
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

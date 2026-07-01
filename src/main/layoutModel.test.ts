import { describe, expect, it } from 'vitest'
import { buildLayoutDigest } from './layoutModel'

/** A placed board at (x,y) sized w×h. */
const b = (id: string, x: number, y: number, w = 100, h = 80, type = 'terminal') => ({
  id,
  type,
  x,
  y,
  w,
  h
})

describe('buildLayoutDigest', () => {
  it('empty canvas → empty digest', () => {
    const d = buildLayoutDigest([])
    expect(d).toEqual({
      version: 1,
      count: 0,
      bbox: null,
      boards: [],
      overlaps: [],
      arrangement: 'empty'
    })
  })

  it('a single placed board → single, bbox = that board', () => {
    const d = buildLayoutDigest([b('a', 10, 20, 200, 100)])
    expect(d.count).toBe(1)
    expect(d.arrangement).toBe('single')
    expect(d.bbox).toEqual({ x: 10, y: 20, w: 200, h: 100 })
    expect(d.overlaps).toEqual([])
  })

  it('drops boards without finite geometry (not placeable)', () => {
    const d = buildLayoutDigest([
      b('a', 0, 0),
      { id: 'noGeo', type: 'terminal' },
      { id: 'nan', type: 'terminal', x: NaN, y: 0, w: 100, h: 80 },
      { id: 'inf', type: 'terminal', x: 0, y: Infinity, w: 100, h: 80 }
    ])
    expect(d.count).toBe(1)
    expect(d.boards.map((bd) => bd.id)).toEqual(['a'])
  })

  it('three boards side by side (same y band) → row', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 140, 0), b('c', 280, 0)])
    expect(d.arrangement).toBe('row')
    expect(d.overlaps).toEqual([])
    expect(d.bbox).toEqual({ x: 0, y: 0, w: 380, h: 80 }) // 280 + 100
  })

  it('three boards stacked (same x band) → column', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 0, 120), b('c', 0, 240)])
    expect(d.arrangement).toBe('column')
  })

  it('a 2×2 non-overlapping block → grid', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 140, 0), b('c', 0, 120), b('d', 140, 120)])
    expect(d.arrangement).toBe('grid')
    expect(d.overlaps).toEqual([])
  })

  it('overlapping boards → scattered + the pair is reported (id-sorted, once)', () => {
    const d = buildLayoutDigest([b('z', 0, 0, 200, 200), b('a', 50, 50, 200, 200)])
    expect(d.arrangement).toBe('scattered')
    expect(d.overlaps).toEqual([{ a: 'a', b: 'z' }]) // sorted a<z, single pair
  })

  it('touching edges do NOT count as overlap (strict intersection)', () => {
    // b starts exactly where a ends on x → adjacent, not overlapping → a clean row.
    const d = buildLayoutDigest([b('a', 0, 0, 100, 80), b('b', 100, 0, 100, 80)])
    expect(d.overlaps).toEqual([])
    expect(d.arrangement).toBe('row')
  })

  it('joins the first Named Group membership as groupId; ungrouped boards omit it', () => {
    const d = buildLayoutDigest(
      [b('a', 0, 0), b('b', 140, 0), b('lone', 280, 0)],
      [{ id: 'g1', name: 'Auth zone', boardIds: ['a', 'b'] }]
    )
    const byId = Object.fromEntries(d.boards.map((bd) => [bd.id, bd]))
    expect(byId.a.groupId).toBe('g1')
    expect(byId.b.groupId).toBe('g1')
    expect('groupId' in byId.lone).toBe(false)
  })

  it('staggered-but-chained boards are ONE row (interval overlap is not transitive)', () => {
    // a–b share a y-band, b–c share a y-band, a–c do NOT — union-find must still make one row.
    const d = buildLayoutDigest([
      b('a', 0, 0, 100, 40),
      b('b', 140, 30, 100, 40), // overlaps a's band (0–40 vs 30–70) and c's (30–70 vs 60–100)
      b('c', 280, 60, 100, 40)
    ])
    expect(d.arrangement).toBe('row')
  })
})

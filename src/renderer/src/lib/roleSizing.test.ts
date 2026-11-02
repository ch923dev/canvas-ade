import { describe, expect, it } from 'vitest'
import { availOf, gridColumns, memberOf, solveGrid, solvePeers, type Cell } from './roleSizing'
import { ROLE_GAP } from './roleTemplates'
import { FIT_MAX_ZOOM, rectsIntersect } from '../../../shared/spatialGeometry'

const term = (id: string): ReturnType<typeof memberOf> =>
  memberOf({ id, type: 'terminal', w: 720, h: 460 }, 'agent')
const plan = (id: string, w: number, h: number): ReturnType<typeof memberOf> =>
  memberOf({ id, type: 'planning', w, h }, 'plan')

const avail = availOf({ w: 1600, h: 1000 })

const overlaps = (cells: readonly Cell[]): boolean =>
  cells.some((a, i) => cells.slice(i + 1).some((b) => rectsIntersect(a, b)))

describe('solvePeers — a rigid board never inflates the peer grid (I2 P3)', () => {
  const ms = [term('t1'), term('t2'), term('t3'), plan('p1', 2400, 1600)]
  const { s } = solvePeers(ms, avail, FIT_MAX_ZOOM)
  const byId = new Map(s.cells.map((c) => [c.id, c]))

  it('the rigid board keeps its exact size and is never marked sized', () => {
    expect(byId.get('p1')).toMatchObject({ w: 2400, h: 1600, sized: false })
  })

  it('terminal cells are sized by the terminals, not by the 2400×1600 plan', () => {
    for (const id of ['t1', 't2', 't3']) {
      const c = byId.get(id)!
      expect(c.h).toBeLessThan(1600)
      expect(c.w).toBeLessThan(2400)
    }
  })

  it('the rigid shelf sits under the grid, ROLE_GAP below it; nothing overlaps', () => {
    const gridBottom = Math.max(
      ...['t1', 't2', 't3'].map((id) => byId.get(id)!.y + byId.get(id)!.h)
    )
    expect(byId.get('p1')!.y).toBe(gridBottom + ROLE_GAP)
    expect(overlaps(s.cells)).toBe(false)
    expect(s.cells).toHaveLength(ms.length)
  })

  it('several rigid boards shelve left→right ROLE_GAP apart', () => {
    const two = solvePeers([term('t1'), plan('p1', 800, 600), plan('p2', 500, 900)], avail, 1)
    const p1 = two.s.cells.find((c) => c.id === 'p1')!
    const p2 = two.s.cells.find((c) => c.id === 'p2')!
    expect(p2.x).toBe(p1.x + p1.w + ROLE_GAP)
    expect(p1.y).toBe(p2.y)
    expect(overlaps(two.s.cells)).toBe(false)
  })

  it('no rigid member (or ONLY rigid members) is exactly gridColumns + solveGrid', () => {
    for (const set of [
      [term('a'), term('b'), term('c')],
      [plan('a', 800, 600), plan('b', 900, 700)]
    ]) {
      const cols = gridColumns(set, avail)
      expect(solvePeers(set, avail, FIT_MAX_ZOOM)).toEqual({
        cols,
        rows: Math.ceil(set.length / cols),
        s: solveGrid(set, cols, avail, FIT_MAX_ZOOM)
      })
    }
  })
})

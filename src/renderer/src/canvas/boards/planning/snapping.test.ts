import { describe, it, expect } from 'vitest'
import { computeSnap, SNAP_TOL } from './snapping'

describe('computeSnap (edge/center, board-local, axis-independent)', () => {
  // static neighbor: left edge at x=100, top at y=0, 50x50
  const neighbor = { x: 100, y: 0, w: 50, h: 50 }

  it('snaps a left edge within tol to the neighbor left edge', () => {
    const moving = { x: 100 + 4, y: 300, w: 50, h: 50 } // 4px off → within SNAP_TOL
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect(r.dx).toBe(-4) // pulls left edge back to 100
    expect(r.dy).toBe(0)
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 100)).toBe(true)
  })

  it('snaps center-to-center', () => {
    const moving = { x: 100 + 3, y: 300, w: 50, h: 50 } // centerX 128 vs neighbor 125 → -3
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect(r.dx).toBe(-3)
  })

  it('does not snap when the nearest anchor is outside tol', () => {
    const moving = { x: 100 + SNAP_TOL + 5, y: 300, w: 50, h: 50 }
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('snaps both axes independently and emits a guide per axis', () => {
    const moving = { x: 104, y: 2, w: 50, h: 50 } // left+4 off 100, top+2 off 0
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect([r.dx, r.dy]).toEqual([-4, -2])
    expect(r.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('no neighbors → no snap', () => {
    expect(computeSnap({ x: 0, y: 0, w: 10, h: 10 }, [], SNAP_TOL)).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})

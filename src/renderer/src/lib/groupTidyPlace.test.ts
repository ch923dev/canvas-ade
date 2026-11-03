import { describe, it, expect } from 'vitest'
import { placeScoped, type ScopedPlacement } from './groupTidyPlace'
import { overlapsAny, PLACE_GAP } from './freeSlot'
import { GROUP_BOX_PAD } from './groupBoxes'
import type { Board } from './boardSchema'
import type { BoardRect } from './boardGeometry'

const board = (id: string, x: number, y: number, w = 300, h = 200, extra = {}): Board =>
  ({ id, type: 'terminal', title: id, x, y, w, h, ...extra }) as Board
const rect = (id: string, x: number, y: number, w = 300, h = 200): BoardRect => ({ id, x, y, w, h })

/** The final rects the placements land at (w/h from the placement, else the board's own). */
function finalRects(placements: ScopedPlacement[], scoped: BoardRect[]): BoardRect[] {
  return placements.map((p) => {
    const own = scoped.find((s) => s.id === p.id)!
    return { id: p.id, x: p.x, y: p.y, w: p.w ?? own.w, h: p.h ?? own.h }
  })
}

function bbox(rs: BoardRect[]): { x: number; y: number; w: number; h: number } {
  const minX = Math.min(...rs.map((r) => r.x))
  const minY = Math.min(...rs.map((r) => r.y))
  const maxX = Math.max(...rs.map((r) => r.x + r.w))
  const maxY = Math.max(...rs.map((r) => r.y + r.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** No final rect overlaps (within PLACE_GAP) any outside board. */
function clearOf(rs: BoardRect[], outside: Board[]): boolean {
  return rs.every((r) => !overlapsAny(outside, r, r))
}

// A group of two boards at the origin, laid side by side by the "engine".
const scoped = [rect('a', 0, 0), rect('b', 0, 300)]
const plan: ScopedPlacement[] = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 328, y: 0 }
]

describe('placeScoped', () => {
  it('keeps a footprint that is clear of every outside board (relocated:false)', () => {
    const outside = [board('n', 2000, 2000)]
    const res = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    expect(res.relocated).toBe(false)
    expect({ dx: res.dx, dy: res.dy }).toEqual({ dx: 0, dy: 0 })
    expect(res.placements).toEqual(plan)
  })

  it('a neighbour at exactly the standard spacing is not a collision', () => {
    // Footprint spans x 0..628; a neighbour PLACE_GAP to its right is the auto-placement spacing.
    const outside = [board('n', 628 + PLACE_GAP, 0)]
    expect(placeScoped(plan, scoped, outside, { x: 0, y: 0 }).relocated).toBe(false)
  })

  it('moves the WHOLE footprint off a collision; no final rect touches any outside board', () => {
    const outside = [board('n', 400, 50)] // butted into where `b` is planned to land
    const res = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    expect(res.relocated).toBe(true)
    expect(clearOf(finalRects(res.placements, scoped), outside)).toBe(true)
  })

  it('keeps the arrangement exactly (identical relative offsets)', () => {
    const outside = [board('n', 400, 50), board('m', -500, 0)]
    const res = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    expect(res.relocated).toBe(true)
    const [a, b] = res.placements
    expect(b.x - a.x).toBe(328)
    expect(b.y - a.y).toBe(0)
    expect(a).toEqual({ id: 'a', x: res.dx, y: res.dy })
  })

  it('the moved footprint clears neighbours by the outline pad too', () => {
    const outside = [board('n', 400, 50)]
    const res = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    const box = bbox(finalRects(res.placements, scoped))
    const padded = {
      x: box.x - GROUP_BOX_PAD,
      y: box.y - GROUP_BOX_PAD,
      w: box.w + 2 * GROUP_BOX_PAD,
      h: box.h + 2 * GROUP_BOX_PAD
    }
    expect(overlapsAny(outside, padded, padded)).toBe(false)
  })

  it("ignores the scope's own pre-tidy positions (only outside boards block)", () => {
    // `n` blocks the plan and the ring's first (right) probe; the next probe (down) is where `b`
    // sits BEFORE the tidy — it is in scope, so it does not block, and the group lands there.
    const outside = [board('n', 650, 0)]
    const res = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    expect(res.relocated).toBe(true)
    const stride = 200 + 2 * GROUP_BOX_PAD + PLACE_GAP
    expect({ dx: res.dx, dy: res.dy }).toEqual({ dx: 0, dy: stride })
  })

  it('counts resized placements toward the footprint', () => {
    // Positions alone clear the neighbour; the planned resize of `b` grows into it.
    const outside = [board('n', 900, 0)]
    const sized: ScopedPlacement[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 328, y: 0, w: 700, h: 200 }
    ]
    expect(placeScoped(plan, scoped, outside, { x: 0, y: 0 }).relocated).toBe(false)
    const res = placeScoped(sized, scoped, outside, { x: 0, y: 0 })
    expect(res.relocated).toBe(true)
    expect(clearOf(finalRects(res.placements, scoped), outside)).toBe(true)
  })

  it('a scoped board the plan did not place keeps its spot — and moves with the group', () => {
    const three = [...scoped, rect('c', 0, 600)]
    const outside = [board('n', 400, 50)]
    const res = placeScoped(plan, three, outside, { x: 0, y: 0 })
    expect(res.placements.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    const c = res.placements.find((p) => p.id === 'c')!
    expect(c).toEqual({ id: 'c', x: 0 + res.dx, y: 600 + res.dy })
  })

  it('is deterministic for any input order', () => {
    const outside = [board('n', 400, 50), board('m', 0, -400), board('k', -700, 0)]
    const one = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    const two = placeScoped([...plan].reverse(), [...scoped].reverse(), [...outside].reverse(), {
      x: 0,
      y: 0
    })
    expect(two).toEqual(one)
  })

  it('ignores docked terminals (no canvas presence)', () => {
    const outside = [board('d', 400, 50, 300, 200, { dockedIn: 'swarm-1' })]
    expect(placeScoped(plan, scoped, outside, { x: 0, y: 0 }).relocated).toBe(false)
  })

  it('exhausted ring search falls back right of every outside board — always free', () => {
    // A dense wall of boards around the anchor, far wider than 16 rings of footprint strides.
    const outside: Board[] = []
    for (let i = -40; i <= 40; i++) {
      for (let j = -40; j <= 40; j++) outside.push(board(`w${i}:${j}`, i * 300, j * 200, 300, 200))
    }
    const res = placeScoped(plan, scoped, outside, { x: 0, y: 0 })
    expect(res.relocated).toBe(true)
    const rs = finalRects(res.placements, scoped)
    expect(clearOf(rs, outside)).toBe(true)
    const right = Math.max(...outside.map((b) => b.x + b.w))
    expect(bbox(rs).x).toBe(right + PLACE_GAP + GROUP_BOX_PAD)
  })

  it('empty scope is a no-op', () => {
    expect(placeScoped([], [], [board('n', 0, 0)], { x: 0, y: 0 })).toEqual({
      placements: [],
      relocated: false,
      dx: 0,
      dy: 0
    })
  })
})

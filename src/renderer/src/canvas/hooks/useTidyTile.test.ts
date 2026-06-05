import { describe, it, expect } from 'vitest'
import { tileArea, TILE_AREA_BASE_W } from './useTidyTile'
import type { BoardRect } from '../../lib/boardGeometry'

const b = (x: number, y: number, w = 100, h = 80): BoardRect => ({ id: `${x},${y}`, x, y, w, h })

describe('tileArea', () => {
  it('returns null when there are no boards', () => {
    expect(tileArea([], 1.6)).toBeNull()
  })

  it('anchors the block at the boards top-left and sizes it to the pane aspect', () => {
    const area = tileArea([b(40, 20), b(300, 400)], 2)
    expect(area).toEqual({ x: 40, y: 20, w: TILE_AREA_BASE_W, h: TILE_AREA_BASE_W / 2 })
  })

  it('uses the min x/y corner across all boards (incl. negatives)', () => {
    const area = tileArea([b(0, 0), b(-120, 50), b(80, -200)], 1.6)
    expect(area?.x).toBe(-120)
    expect(area?.y).toBe(-200)
  })

  it('taller (aspect<1) blocks are taller than wide; wider (aspect>1) the reverse', () => {
    expect(tileArea([b(0, 0)], 0.5)).toEqual({
      x: 0,
      y: 0,
      w: TILE_AREA_BASE_W,
      h: TILE_AREA_BASE_W / 0.5
    })
  })
})

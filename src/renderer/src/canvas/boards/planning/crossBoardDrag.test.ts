/**
 * Unit tests for the pure Phase-4 cross-board drag helpers (spec §3.C / §4.3): the
 * drop-target resolution, the grab-anchor offset, and the screen→target-local placement math
 * (incl. the mode-independent grab anchor, the across-zoom mapping, and the ≥0 clamp). The
 * gesture wiring + the real-input hit-test are pinned in e2e (`planningCrossBoardDrag.e2e.ts`).
 */
import { describe, it, expect } from 'vitest'
import {
  dropPlacement,
  grabAnchorOffset,
  resolveDropTarget,
  type DropBoard
} from './crossBoardDrag'

const boards: DropBoard[] = [
  { id: 'src', type: 'planning' },
  { id: 'dst', type: 'planning' },
  { id: 'term', type: 'terminal' }
]

describe('resolveDropTarget', () => {
  it('resolves a DIFFERENT planning board to the drop target', () => {
    expect(resolveDropTarget('dst', 'src', boards)).toBe('dst')
  })
  it('rejects the source board (a within-board drop, not a transfer)', () => {
    expect(resolveDropTarget('src', 'src', boards)).toBeNull()
  })
  it('rejects a null hit (over empty canvas / no well under the cursor)', () => {
    expect(resolveDropTarget(null, 'src', boards)).toBeNull()
  })
  it('rejects a non-planning board (defensive — only planning wells carry the attribute)', () => {
    expect(resolveDropTarget('term', 'src', boards)).toBeNull()
  })
  it('rejects a stale / unknown board id', () => {
    expect(resolveDropTarget('gone', 'src', boards)).toBeNull()
  })
})

describe('grabAnchorOffset', () => {
  it('is the grab point minus the selection union top-left (board-local)', () => {
    expect(grabAnchorOffset({ x: 130, y: 90 }, { x: 100, y: 40 })).toEqual({ x: 30, y: 50 })
  })
  it('is zero when the grab is exactly at the union top-left', () => {
    expect(grabAnchorOffset({ x: 12, y: 34 }, { x: 12, y: 34 })).toEqual({ x: 0, y: 0 })
  })
})

describe('dropPlacement', () => {
  // A target well laid out 1:1 (rendered width == layout width → scale 1). The grabbed point
  // (100,50) into the well, minus the grab anchor (10,20), lands the payload top-left at (90,30).
  it('maps the cursor into target-local space and subtracts the grab anchor (zoom 1)', () => {
    expect(
      dropPlacement({
        cursor: { x: 500 + 100, y: 300 + 50 },
        targetRect: { left: 500, top: 300, width: 240 },
        targetLayoutWidth: 240,
        fallbackZoom: 1,
        grabOffset: { x: 10, y: 20 }
      })
    ).toEqual({ x: 90, y: 30 })
  })

  // The same drop at 2× camera zoom: the well renders twice its layout width, so 200 screen px
  // from the well's left edge is 100 board-local px — the SAME placement as the zoom-1 case
  // (the mapping is zoom-correct).
  it('divides by the measured target scale so placement is identical across zooms', () => {
    expect(
      dropPlacement({
        cursor: { x: 500 + 200, y: 300 + 100 },
        targetRect: { left: 500, top: 300, width: 480 },
        targetLayoutWidth: 240,
        fallbackZoom: 1,
        grabOffset: { x: 10, y: 20 }
      })
    ).toEqual({ x: 90, y: 30 })
  })

  it('clamps the placement to ≥ 0 so a drop near the top-left still lands inside the board', () => {
    expect(
      dropPlacement({
        cursor: { x: 505, y: 302 },
        targetRect: { left: 500, top: 300, width: 240 },
        targetLayoutWidth: 240,
        fallbackZoom: 1,
        grabOffset: { x: 40, y: 40 }
      })
    ).toEqual({ x: 0, y: 0 })
  })

  it('falls back to the camera zoom when the target well is not laid out yet (width 0)', () => {
    // offsetWidth 0 → screenScale returns the fallback zoom (2). 100 screen px ÷ 2 = 50 board px.
    expect(
      dropPlacement({
        cursor: { x: 500 + 100, y: 300 + 100 },
        targetRect: { left: 500, top: 300, width: 0 },
        targetLayoutWidth: 0,
        fallbackZoom: 2,
        grabOffset: { x: 0, y: 0 }
      })
    ).toEqual({ x: 50, y: 50 })
  })
})

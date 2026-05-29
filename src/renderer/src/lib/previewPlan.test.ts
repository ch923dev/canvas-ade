import { describe, it, expect } from 'vitest'
import {
  isLiveEligible,
  pickLive,
  rectsOverlap,
  chromeExclusionZones,
  shouldDemoteForOcclusion,
  type LiveCandidate,
  type Box
} from './previewPlan'

const at = (id: string, y: number): LiveCandidate => ({ id, screenY: y, w: 100, h: 100 })

describe('isLiveEligible', () => {
  it('rejects when below the LOD zoom', () => {
    expect(isLiveEligible({ zoom: 0.3, lod: 0.4, screenY: 0, paneTop: 0, w: 100, h: 100 })).toBe(
      false
    )
  })
  it('rejects a degenerate stage', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: 0, paneTop: 0, w: 1, h: 1 })).toBe(false)
  })
  it('rejects when the stage sits above the pane top', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: -5, paneTop: 0, w: 100, h: 100 })).toBe(
      false
    )
  })
  it('accepts an in-band, on-pane, sized stage', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: 10, paneTop: 0, w: 100, h: 100 })).toBe(
      true
    )
  })
  it('accepts at exactly the LOD boundary (zoom === lod)', () => {
    expect(isLiveEligible({ zoom: 0.4, lod: 0.4, screenY: 0, paneTop: 0, w: 100, h: 100 })).toBe(
      true
    )
  })
  it('accepts the smallest non-degenerate stage (w === 2, h === 2)', () => {
    expect(isLiveEligible({ zoom: 1, lod: 0.4, screenY: 0, paneTop: 0, w: 2, h: 2 })).toBe(true)
  })

  // Focus isolation (occlusion fix): when a focus is active, only the focused board
  // may stay live; every other Browser board must demote to its dimmable snapshot.
  it('rejects a non-focused board while a focus is active', () => {
    expect(
      isLiveEligible({
        zoom: 1,
        lod: 0.4,
        screenY: 10,
        paneTop: 0,
        w: 100,
        h: 100,
        focusActive: true,
        isFocused: false
      })
    ).toBe(false)
  })
  it('keeps the focused board itself eligible while a focus is active', () => {
    expect(
      isLiveEligible({
        zoom: 1,
        lod: 0.4,
        screenY: 10,
        paneTop: 0,
        w: 100,
        h: 100,
        focusActive: true,
        isFocused: true
      })
    ).toBe(true)
  })
  it('ignores focus flags when no focus is active', () => {
    expect(
      isLiveEligible({
        zoom: 1,
        lod: 0.4,
        screenY: 10,
        paneTop: 0,
        w: 100,
        h: 100,
        focusActive: false,
        isFocused: false
      })
    ).toBe(true)
  })
})

describe('pickLive', () => {
  it('keeps at most `cap` candidates (first-come when no center given)', () => {
    expect(pickLive([at('a', 1), at('b', 2), at('c', 3)], 2)).toEqual(['a', 'b'])
  })
  it('returns all when under the cap', () => {
    expect(pickLive([at('a', 1)], 4)).toEqual(['a'])
  })

  // Bug #8: with a viewport center, the nearest `cap` boards win the live slots
  // (on-screen relevance), not store/creation order.
  describe('viewport-aware selection (Bug #8)', () => {
    // Stage centre = (screenX + w/2, screenY + h/2). All w=h=100 here, so centre
    // offset is (+50, +50). center at (50, 50) means a board at (0,0) is nearest.
    const near = (id: string, x: number, y: number): LiveCandidate => ({
      id,
      screenX: x,
      screenY: y,
      w: 100,
      h: 100
    })

    it('keeps the `cap` candidates nearest the viewport centre', () => {
      const center = { x: 50, y: 50 }
      // far=(1000,1000), near=(0,0), mid=(300,300). cap 2 → near + mid (not far).
      const picked = pickLive(
        [near('far', 1000, 1000), near('near', 0, 0), near('mid', 300, 300)],
        2,
        center
      )
      expect(picked.sort()).toEqual(['mid', 'near'])
    })

    it('does not exceed the cap even with a centre', () => {
      const center = { x: 0, y: 0 }
      expect(
        pickLive([near('a', 0, 0), near('b', 10, 10), near('c', 20, 20)], 2, center)
      ).toHaveLength(2)
    })

    it('returns all (still bounded by cap) when under the cap with a centre', () => {
      const center = { x: 0, y: 0 }
      expect(pickLive([near('a', 500, 500)], 4, center)).toEqual(['a'])
    })

    it('is stable across equal distances (first-come tie-break)', () => {
      const center = { x: 50, y: 50 }
      // a and b are equidistant from centre → original order preserved.
      const picked = pickLive([near('a', 0, 0), near('b', 0, 0), near('z', 9999, 9999)], 2, center)
      expect(picked).toEqual(['a', 'b'])
    })
  })
})

// ── Static-overlap occlusion (LOT F: #2/#19/#20/#21) ──────────────────────────
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height })

describe('rectsOverlap', () => {
  it('detects overlapping boxes', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(50, 50, 100, 100))).toBe(true)
  })
  it('detects containment', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(25, 25, 10, 10))).toBe(true)
  })
  it('is false for fully disjoint boxes', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(200, 200, 50, 50))).toBe(false)
  })
  it('treats a shared edge as NOT overlapping (strict)', () => {
    // b starts exactly where a ends on x → touching, not overlapping.
    expect(rectsOverlap(box(0, 0, 100, 100), box(100, 0, 50, 100))).toBe(false)
  })
  it('is false when either box has zero/negative area', () => {
    expect(rectsOverlap(box(0, 0, 0, 100), box(0, 0, 100, 100))).toBe(false)
    expect(rectsOverlap(box(0, 0, 100, 100), box(0, 0, 100, -5))).toBe(false)
  })
})

describe('chromeExclusionZones', () => {
  // A typical full-bleed pane (window content 1280×820, paneOffset ~0,0).
  const pane = { x: 0, y: 0, w: 1280, h: 820 }
  const zones = chromeExclusionZones(pane)

  it('returns a dock zone and a top-right zone', () => {
    expect(zones).toHaveLength(2)
  })
  it('pins the dock to the bottom-centre band', () => {
    const [dock] = zones
    // centred horizontally, flush to the pane bottom.
    expect(dock.x + dock.width / 2).toBe(pane.x + pane.w / 2)
    expect(dock.y + dock.height).toBe(pane.h)
    expect(dock.y).toBeGreaterThan(700) // bottom band only, not the whole pane
  })
  it('pins the top-right zone to the top-right corner', () => {
    const [, topRight] = zones
    expect(topRight.x + topRight.width).toBe(pane.x + pane.w) // flush right
    expect(topRight.y).toBe(pane.y) // flush top
    expect(topRight.width).toBeLessThan(pane.w / 2) // a corner, not a strip
  })
  it('tracks paneOffset (non-zero origin / inset pane)', () => {
    const offset = chromeExclusionZones({ x: 100, y: 40, w: 800, h: 600 })
    const [dock, topRight] = offset
    expect(dock.y + dock.height).toBe(40 + 600) // bottom = offset.y + h
    expect(topRight.x + topRight.width).toBe(100 + 800) // right = offset.x + w
  })
  it('leaves a centred mid-pane stage clear of both zones', () => {
    // The e2e seeds a centred, non-overlapping Browser board — it must stay live.
    const stage = box(315, 239, 651, 406) // measured desktop stage, fitView(700×500)
    expect(zones.some((z) => rectsOverlap(stage, z))).toBe(false)
  })
})

describe('shouldDemoteForOcclusion', () => {
  const pane = { x: 0, y: 0, w: 1280, h: 820 }
  const zones = chromeExclusionZones(pane)

  const baseInput = (over: Partial<Parameters<typeof shouldDemoteForOcclusion>[0]> = {}) => ({
    id: 'browser-1',
    stage: box(300, 300, 200, 150),
    selectedId: null,
    selectedRect: null,
    chromeZones: zones,
    ...over
  })

  it('does not demote a clear, unselected, on-canvas live view (the e2e guard)', () => {
    expect(shouldDemoteForOcclusion(baseInput())).toBe(false)
  })

  // #2 / #19 / #20 — overlaps a DIFFERENT selected board.
  it('demotes when overlapping a different selected board', () => {
    expect(
      shouldDemoteForOcclusion(
        baseInput({ selectedId: 'board-2', selectedRect: box(350, 350, 200, 200) })
      )
    ).toBe(true)
  })
  it('does NOT demote when the SELECTED board is the Browser board itself', () => {
    // Selecting the browser board (e.g. the e2e auto-select) must keep it live.
    expect(
      shouldDemoteForOcclusion(
        baseInput({ selectedId: 'browser-1', selectedRect: box(290, 290, 300, 300) })
      )
    ).toBe(false)
  })
  it('does NOT demote on overlap with an UNSELECTED board (incidental overlap)', () => {
    // No selection → incidental overlap with another board must not kill the preview.
    expect(shouldDemoteForOcclusion(baseInput({ selectedId: null, selectedRect: null }))).toBe(
      false
    )
  })
  it('does NOT demote when the selected board is elsewhere (no overlap)', () => {
    expect(
      shouldDemoteForOcclusion(
        baseInput({ selectedId: 'board-2', selectedRect: box(900, 600, 100, 100) })
      )
    ).toBe(false)
  })

  // #21 — overlaps a fixed chrome zone.
  it('demotes when the stage overlaps the dock zone', () => {
    expect(shouldDemoteForOcclusion(baseInput({ stage: box(500, 780, 200, 40) }))).toBe(true)
  })
  it('demotes when the stage overlaps the top-right camera/diag zone', () => {
    expect(shouldDemoteForOcclusion(baseInput({ stage: box(1100, 10, 150, 60) }))).toBe(true)
  })
  it('demotes for a chrome overlap even with no selection', () => {
    expect(
      shouldDemoteForOcclusion(
        baseInput({ selectedId: null, selectedRect: null, stage: box(500, 790, 100, 30) })
      )
    ).toBe(true)
  })
})

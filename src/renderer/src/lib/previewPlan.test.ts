import { describe, it, expect } from 'vitest'
import { isLiveEligible, pickLive, type LiveCandidate } from './previewPlan'

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

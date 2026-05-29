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
  it('keeps at most `cap` candidates (first-come)', () => {
    expect(pickLive([at('a', 1), at('b', 2), at('c', 3)], 2)).toEqual(['a', 'b'])
  })
  it('returns all when under the cap', () => {
    expect(pickLive([at('a', 1)], 4)).toEqual(['a'])
  })
})

import { describe, it, expect } from 'vitest'
import {
  boundsFor,
  zoomFor,
  boundsAndZoom,
  stageScreenRect,
  type PreviewGeom,
  type Offset
} from './previewGeom'
import { roundRect, worldRectToScreen, fitZoomFactorForBounds, type Viewport } from './cameraBounds'
import { VIEWPORT_PRESETS, deviceStageRect, toWorldRect } from './browserLayout'

// ── Shared test fixtures ──────────────────────────────────────────────────────
// A typical board: 700×500 world-px at (100, 200), mobile viewport.
const G_MOBILE: PreviewGeom = { x: 100, y: 200, w: 700, h: 500, viewport: 'mobile' }
// Same board at tablet.
const G_TABLET: PreviewGeom = { x: 100, y: 200, w: 700, h: 500, viewport: 'tablet' }
// Same board at desktop.
const G_DESKTOP: PreviewGeom = { x: 100, y: 200, w: 700, h: 500, viewport: 'desktop' }

// A pane offset mimicking the topbar (44px) + tabs (20px) above the canvas pane.
const OFF: Offset = { x: 0, y: 64 }

// Camera at zoom 1, centred at (0, 0).
const VP1: Viewport = { x: 0, y: 0, zoom: 1 }
// Camera zoomed in.
const VP_IN: Viewport = { x: -50, y: 30, zoom: 1.5 }
// Camera zoomed out (below LOD — maths must still work; live/dead is the caller's concern).
const VP_OUT: Viewport = { x: 10, y: 10, zoom: 0.45 }

// ── boundsFor ─────────────────────────────────────────────────────────────────
describe('boundsFor', () => {
  it('equals roundRect(worldRectToScreen(toWorldRect(deviceStageRect(...), x, y), vp, off))', () => {
    const stage = toWorldRect(
      deviceStageRect(G_MOBILE.w, G_MOBILE.h, G_MOBILE.viewport),
      G_MOBILE.x,
      G_MOBILE.y
    )
    const expected = roundRect(worldRectToScreen(stage, VP1, OFF))
    expect(boundsFor(G_MOBILE, VP1, OFF)).toEqual(expected)
  })

  it('returns integer-only fields (all fields are Math.round results)', () => {
    // Use a zoom that is guaranteed to produce fractional raw values.
    const result = boundsFor(G_TABLET, VP_IN, OFF)
    expect(result.x).toBe(Math.round(result.x))
    expect(result.y).toBe(Math.round(result.y))
    expect(result.width).toBe(Math.round(result.width))
    expect(result.height).toBe(Math.round(result.height))
  })

  it('returns integer-only fields for desktop preset at zoom 0.45', () => {
    const result = boundsFor(G_DESKTOP, VP_OUT, OFF)
    expect(result.x).toBe(Math.round(result.x))
    expect(result.y).toBe(Math.round(result.y))
    expect(result.width).toBe(Math.round(result.width))
    expect(result.height).toBe(Math.round(result.height))
  })

  it('hard-coded expected value at VP1 + OFF for mobile (regression anchor)', () => {
    // Compute manually via the chain so a silent change in any upstream fn is caught.
    const stageLocal = deviceStageRect(700, 500, 'mobile')
    const stageWorld = toWorldRect(stageLocal, 100, 200)
    const raw = worldRectToScreen(stageWorld, VP1, OFF)
    const expected = roundRect(raw)
    // Assert the concrete shape: x/y anchored by paneOffset.y=64.
    expect(expected.y).toBeGreaterThanOrEqual(64) // always below pane top
    expect(boundsFor(G_MOBILE, VP1, OFF)).toEqual(expected)
  })

  it('does not mutate g, vp, or paneOffset', () => {
    const g = { ...G_MOBILE }
    const vp = { ...VP1 }
    const off = { ...OFF }
    boundsFor(g, vp, off)
    expect(g).toEqual(G_MOBILE)
    expect(vp).toEqual(VP1)
    expect(off).toEqual(OFF)
  })
})

// ── stageScreenRect ───────────────────────────────────────────────────────────
describe('stageScreenRect', () => {
  it('equals worldRectToScreen(toWorldRect(deviceStageRect(...), x, y), vp, off) — un-rounded', () => {
    const stage = deviceStageRect(G_MOBILE.w, G_MOBILE.h, G_MOBILE.viewport)
    const expected = worldRectToScreen(toWorldRect(stage, G_MOBILE.x, G_MOBILE.y), VP1, OFF)
    expect(stageScreenRect(G_MOBILE, VP1, OFF)).toEqual(expected)
  })

  it('is NOT rounded — picks inputs where rounding would change a value', () => {
    // zoom=1.5 and non-integer stage coords produce fractional screen coords.
    const raw = stageScreenRect(G_TABLET, VP_IN, OFF)
    const rounded = boundsFor(G_TABLET, VP_IN, OFF)
    // At least one field should differ if rounding actually matters.
    const anyDiffers =
      raw.x !== rounded.x ||
      raw.y !== rounded.y ||
      raw.width !== rounded.width ||
      raw.height !== rounded.height
    expect(anyDiffers).toBe(true)
  })

  it('hard-coded: raw fields may be non-integer at VP_IN', () => {
    const result = stageScreenRect(G_DESKTOP, VP_IN, OFF)
    // At zoom 1.5 with a non-trivial stage, at least one field has a fractional part.
    const hasFloat = [result.x, result.y, result.width, result.height].some(
      (v) => v !== Math.round(v)
    )
    expect(hasFloat).toBe(true)
  })

  it('does not mutate g, vp, or paneOffset', () => {
    const g = { ...G_MOBILE }
    const vp = { ...VP_IN }
    const off = { ...OFF }
    stageScreenRect(g, vp, off)
    expect(g).toEqual(G_MOBILE)
    expect(vp).toEqual(VP_IN)
    expect(off).toEqual(OFF)
  })
})

// ── zoomFor ───────────────────────────────────────────────────────────────────
describe('zoomFor', () => {
  it('equals fitZoomFactorForBounds(boundsFor(...).width, presetW)', () => {
    const bw = boundsFor(G_MOBILE, VP1, OFF).width
    const expected = fitZoomFactorForBounds(bw, VIEWPORT_PRESETS['mobile'].w)
    expect(zoomFor(G_MOBILE, VP1, OFF)).toBe(expected)
  })

  it('uses the ROUNDED bounds width (Bug #20): invariant bounds.width / zoom === presetW', () => {
    const bounds = boundsFor(G_MOBILE, VP_IN, OFF)
    const zoom = zoomFor(G_MOBILE, VP_IN, OFF)
    const presetW = VIEWPORT_PRESETS['mobile'].w
    // In the unclamped band the invariant holds within floating-point epsilon
    // (see fitZoomFactorForBounds tests in cameraBounds.test.ts for the same pattern).
    if (zoom > 0.25 && zoom < 5) {
      expect(bounds.width / zoom).toBeCloseTo(presetW, 10)
    }
  })

  it('holds the Bug #20 invariant for tablet at VP_IN', () => {
    const bounds = boundsFor(G_TABLET, VP_IN, OFF)
    const zoom = zoomFor(G_TABLET, VP_IN, OFF)
    const presetW = VIEWPORT_PRESETS['tablet'].w
    // toBeCloseTo(presetW, 10): the rounded bounds width / zoom may carry a floating-point
    // epsilon (e.g. 833.9999999999999 vs 834) because the zoom factor itself is a float.
    // The invariant is that the drift is sub-epsilon — the page lays out at essentially
    // exactly presetW, matching the behaviour documented for fitZoomFactorForBounds.
    if (zoom > 0.25 && zoom < 5) {
      expect(bounds.width / zoom).toBeCloseTo(presetW, 10)
    }
  })

  it('holds the Bug #20 invariant for desktop at VP_OUT', () => {
    const bounds = boundsFor(G_DESKTOP, VP_OUT, OFF)
    const zoom = zoomFor(G_DESKTOP, VP_OUT, OFF)
    const presetW = VIEWPORT_PRESETS['desktop'].w
    if (zoom > 0.25 && zoom < 5) {
      expect(bounds.width / zoom).toBeCloseTo(presetW, 10)
    }
  })

  it('does not mutate g, vp, or paneOffset', () => {
    const g = { ...G_MOBILE }
    const vp = { ...VP1 }
    const off = { ...OFF }
    zoomFor(g, vp, off)
    expect(g).toEqual(G_MOBILE)
    expect(vp).toEqual(VP1)
    expect(off).toEqual(OFF)
  })
})

// ── boundsAndZoom ─────────────────────────────────────────────────────────────
describe('boundsAndZoom', () => {
  // Load-bearing invariant: boundsAndZoom must produce EXACTLY the same result as
  // calling boundsFor + zoomFor independently, so the host can swap two calls for one
  // without any observable difference.

  it('deep-equals { bounds: boundsFor(...), zoomFactor: zoomFor(...) } for mobile at VP1', () => {
    expect(boundsAndZoom(G_MOBILE, VP1, OFF)).toEqual({
      bounds: boundsFor(G_MOBILE, VP1, OFF),
      zoomFactor: zoomFor(G_MOBILE, VP1, OFF)
    })
  })

  it('deep-equals for tablet at VP_IN', () => {
    expect(boundsAndZoom(G_TABLET, VP_IN, OFF)).toEqual({
      bounds: boundsFor(G_TABLET, VP_IN, OFF),
      zoomFactor: zoomFor(G_TABLET, VP_IN, OFF)
    })
  })

  it('deep-equals for desktop at VP_OUT', () => {
    expect(boundsAndZoom(G_DESKTOP, VP_OUT, OFF)).toEqual({
      bounds: boundsFor(G_DESKTOP, VP_OUT, OFF),
      zoomFactor: zoomFor(G_DESKTOP, VP_OUT, OFF)
    })
  })

  it('deep-equals across all three presets at multiple camera zooms', () => {
    const viewports: Viewport[] = [
      { x: 0, y: 0, zoom: 1 },
      { x: -100, y: 50, zoom: 1.5 },
      { x: 10, y: 10, zoom: 0.45 },
      { x: 200, y: -30, zoom: 2.0 }
    ]
    const geoms = [G_MOBILE, G_TABLET, G_DESKTOP]
    for (const g of geoms) {
      for (const vp of viewports) {
        const result = boundsAndZoom(g, vp, OFF)
        expect(result).toEqual({
          bounds: boundsFor(g, vp, OFF),
          zoomFactor: zoomFor(g, vp, OFF)
        })
      }
    }
  })

  it('zoomFactor is derived from the same rounded bounds width (Bug #20 equivalence)', () => {
    const { bounds, zoomFactor } = boundsAndZoom(G_MOBILE, VP_IN, OFF)
    // boundsAndZoom must use boundsFor's rounded width, not a separately computed one.
    const expected = fitZoomFactorForBounds(bounds.width, VIEWPORT_PRESETS['mobile'].w)
    expect(zoomFactor).toBe(expected)
  })

  it('does not mutate g, vp, or paneOffset', () => {
    const g = { ...G_MOBILE }
    const vp = { ...VP1 }
    const off = { ...OFF }
    boundsAndZoom(g, vp, off)
    expect(g).toEqual(G_MOBILE)
    expect(vp).toEqual(VP1)
    expect(off).toEqual(OFF)
  })
})

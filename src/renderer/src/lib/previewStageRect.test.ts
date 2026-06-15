import { describe, it, expect } from 'vitest'
import { stageScreenRect, type PreviewGeom, type Offset } from './previewStageRect'
import { roundRect, worldRectToScreen, type Viewport } from './cameraBounds'
import { deviceStageRect, toWorldRect } from './browserLayout'

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

describe('stageScreenRect', () => {
  it('equals worldRectToScreen(toWorldRect(deviceStageRect(...), x, y), vp, off) — un-rounded', () => {
    const stage = deviceStageRect(G_MOBILE.w, G_MOBILE.h, G_MOBILE.viewport)
    const expected = worldRectToScreen(toWorldRect(stage, G_MOBILE.x, G_MOBILE.y), VP1, OFF)
    expect(stageScreenRect(G_MOBILE, VP1, OFF)).toEqual(expected)
  })

  it('is NOT rounded — picks inputs where rounding would change a value', () => {
    // zoom=1.5 and non-integer stage coords produce fractional screen coords.
    const raw = stageScreenRect(G_TABLET, VP_IN, OFF)
    const rounded = roundRect(raw)
    // At least one field should differ if rounding actually matters.
    const anyDiffers =
      raw.x !== rounded.x ||
      raw.y !== rounded.y ||
      raw.width !== rounded.width ||
      raw.height !== rounded.height
    expect(anyDiffers).toBe(true)
  })

  it('hard-coded raw literal at VP_IN + OFF for desktop (regression anchor)', () => {
    // Fully literal expectations — computed once by running the chain and baking the result.
    // Catches silent changes in deviceStageRect / toWorldRect / worldRectToScreen.
    expect(stageScreenRect(G_DESKTOP, VP_IN, OFF)).toEqual({
      x: 136.90000000000003,
      y: 512.5,
      width: 976.1999999999999,
      height: 609
    })
  })

  it('hard-coded raw literal at VP1 + OFF for mobile (regression anchor)', () => {
    // zoom=1 so no zoom scaling; fractional x/width confirm the result is un-rounded.
    expect(stageScreenRect(G_MOBILE, VP1, OFF)).toEqual({
      x: 356.7345971563981,
      y: 343,
      width: 186.53080568720378,
      height: 406
    })
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

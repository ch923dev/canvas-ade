/**
 * OSR input-coordinate mapping (pure, no Electron runtime) — extracted from previewOsr.ts under the
 * file-size doctrine (a NEW concern lands in its own module rather than growing a file at its cap).
 *
 * The renderer (`useOffscreenInput`) forwards pointer events in page-logical CSS px; MAIN must scale
 * them into the offscreen widget's coordinate space before `sendInputEvent`, or a supersampled board
 * hit-tests up-left of the cursor (the hover-misalignment bug). The transform is the inverse of the
 * page zoom factor `applyOsrSize` sets, so it lives next to that sizing math conceptually. Unit-tested
 * in previewOsr.test.ts.
 */

/** A renderer-built input event forwarded to the offscreen view. The exact union `sendInputEvent`
 *  accepts (mouse / wheel / keyboard members), so a scaled event stays assignable to it. */
export type OsrInputEvent = Parameters<Electron.WebContents['sendInputEvent']>[0]

/** Input event types that carry pointer coordinates (`x`/`y`); keyboard events (`keyDown`/`keyUp`/
 *  `char`) do not. */
const OSR_POINTER_TYPES: ReadonlySet<string> = new Set([
  'mouseDown',
  'mouseUp',
  'mouseMove',
  'mouseEnter',
  'mouseLeave',
  'contextMenu',
  'mouseWheel'
])

/**
 * Scale a forwarded pointer event's coordinates from page-logical CSS px (what the renderer sends —
 * the active preset's box, e.g. [0,390]×[0,844], via `useOffscreenInput.toPage`) into the offscreen
 * widget's coordinate space, so the hover/click lands UNDER the real cursor.
 *
 * WHY this is needed (the hover-misalignment fix): `applyOsrSize` sizes the offscreen window to
 * `logical·S` and sets its page zoom factor to `S` (the M1 supersample). `sendInputEvent` coordinates
 * are in the widget's space — `logical·S` wide — NOT page-CSS px. The page un-zooms by `S` during
 * hit-test, so an element at CSS (x,y) sits at widget (x·S, y·S). Forwarding the renderer's logical
 * (x,y) unscaled therefore hit-tests at (x/S, y/S) — up and to the LEFT of the cursor, worsening with
 * distance from the top-left as `S` grows past 1 (e.g. a HiDPI monitor where dpr≥1.25 makes S>1 even
 * at rest). Input was built (M3, #163) believing logical px were "supersample-independent"; M1 (#155)
 * made S>1 without updating the transform. `superSample` is the live page zoom factor (it is exactly
 * what `setZoomFactor` was last given), so multiplying by it inverts the zoom precisely.
 *
 * Keyboard events (no x/y) pass through untouched. Wheel `deltaX/deltaY` are scroll AMOUNTS, not
 * coordinates, so they are deliberately NOT scaled (Blink applies the page zoom to scrolling itself);
 * only the wheel's anchor x/y are scaled. At S===1 (the common zoomed-out / dpr-1 case) this is a
 * pass-through, so there is no behaviour change where input already worked.
 */
export function scaleOsrInputEvent(event: OsrInputEvent, superSample: number): OsrInputEvent {
  const s = Number.isFinite(superSample) && superSample > 0 ? superSample : 1
  if (s === 1 || !OSR_POINTER_TYPES.has(event.type)) return event
  const m = event as Extract<OsrInputEvent, { x: number; y: number }>
  return { ...m, x: Math.round(m.x * s), y: Math.round(m.y * s) }
}

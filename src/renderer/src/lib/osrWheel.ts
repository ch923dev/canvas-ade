/**
 * OS-3 Phase 3 — pure wheel-delta mapping for the offscreen (OSR) Browser preview.
 *
 * The forwarded wheel (`useOffscreenInput.ts`) used a crude `deltaMode===1 ? 16 : 1` factor and
 * set no precise-scroll hint, so trackpad scrolling was coarse and mouse-wheel notches over/under-
 * shot. This maps a DOM `WheelEvent`'s `deltaMode` to pixel deltas + the `hasPreciseScrollingDeltas`
 * hint Electron's `sendInputEvent({type:'mouseWheel', …})` understands. Pure → unit-testable.
 *
 *   - `deltaMode 0` (pixel — trackpads / high-res mice): deltas pass through 1:1; precise hint ON
 *     (Chromium then does smooth, momentum-aware scrolling instead of stepped wheel ticks).
 *   - `deltaMode 1` (line): × `LINE_HEIGHT_PX` (~Chromium's mouse-wheel line default — replaces the
 *     too-small 16, which made one notch barely move the page).
 *   - `deltaMode 2` (page): × the page's logical height.
 *
 * Sign is negated: a DOM wheel `deltaY>0` scrolls DOWN, but Electron's `mouseWheel` `deltaY>0`
 * scrolls UP (it is "content motion", inverted from "scroll amount").
 */

/** The fields of a DOM WheelEvent this mapper reads (a real WheelEvent satisfies it). */
export interface OsrWheelInfo {
  deltaX: number
  deltaY: number
  /** 0 = pixel, 1 = line, 2 = page. */
  deltaMode: number
}

/** The wheel fields merged into the forwarded `mouseWheel` `sendInputEvent`. */
export interface OsrWheelDelta {
  deltaX: number
  deltaY: number
  hasPreciseScrollingDeltas: boolean
  canScroll: boolean
}

/** Pixels per wheel line (deltaMode 1). ~Chromium's default mouse-wheel line step. */
export const LINE_HEIGHT_PX = 40

/** Map a wheel event to Electron `mouseWheel` deltas at the active preset's logical page height. */
export function mapOsrWheel(e: OsrWheelInfo, pageH: number): OsrWheelDelta {
  const unit = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? pageH : 1
  return {
    deltaX: -e.deltaX * unit,
    deltaY: -e.deltaY * unit,
    hasPreciseScrollingDeltas: e.deltaMode === 0,
    canScroll: true
  }
}

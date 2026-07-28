import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** The React Flow pane's viewport-space box, in the shape both liveness managers consume. */
export interface PaneRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * R6 (audit P-2) — a CACHED pane box, so the liveness managers stop forcing layout per drag frame.
 *
 * Both `useTerminalLiveness` and `useOffscreenLiveness` reconcile on every `boards`-ref change, and
 * a node drag mutates `boards` ~60×/s. Each used to open its reconcile with
 * `paneRef.current.getBoundingClientRect()` — a SYNCHRONOUS layout flush, twice per frame, on the
 * drag path. Their existing diff-skips guard only the store write / the IPC; the layout read ran
 * unconditionally, which is the half P-2 is about.
 *
 * The pane's box cannot change because a board inside it moved, so measuring per frame was always
 * answering a question whose answer had not changed. Instead we measure on the only things that CAN
 * move it and re-read the cache otherwise:
 *   - `ResizeObserver` on the pane — covers app-chrome relayout (Jarvis panel opening, dock, a
 *     window resize that reflows). Reading the rect inside an RO callback is cheap by construction:
 *     the callback runs after layout and before paint, so there is nothing to flush.
 *   - `window` resize — belt and braces for a move that somehow leaves the box identical.
 *   - `animationend`, captured at the window. A `ResizeObserver` does NOT fire for a TRANSFORM: a
 *     transform never changes the layout box, but it does change what `getBoundingClientRect`
 *     reports. `.st-app-rise` (`styles/screens/switch-transition.css`) animates
 *     `scale(1.03) translateY(10px)` → identity for 240 ms on an ANCESTOR of the pane, and `Canvas`
 *     mounts inside that window on every project switch — so a mount-time measurement can latch a
 *     ~3%-scaled, 10px-shifted box that nothing would ever correct. Re-measuring when an animation
 *     ends closes that. Capture is required because the animation runs on an ancestor, not the
 *     pane. This is rare (animation ends, not frames), so it costs nothing on the drag path.
 *
 * Note the consequence, which is the behaviour we want: DURING that rise the cache serves the
 * SETTLED box rather than the mid-animation one. Liveness should not flip because of a 240 ms
 * cosmetic transform — the old per-reconcile measurement did read the transformed box.
 *
 * Returns a STABLE getter rather than the rect itself: the consumers hold `reconcile` in a
 * `useCallback` whose identity gates a store subscription, so handing them a value that changes on
 * resize would tear down and re-arm that subscription for no reason.
 *
 * A zero-area or unmounted pane reads as `null` — the same "not laid out yet, do nothing" signal the
 * callers already bail on.
 */
export function usePaneRect(paneRef: RefObject<HTMLElement | null>): () => PaneRect | null {
  const rectRef = useRef<PaneRect | null>(null)

  const measure = useCallback((): void => {
    const el = paneRef.current
    if (!el) {
      rectRef.current = null
      return
    }
    const r = el.getBoundingClientRect()
    rectRef.current =
      r.width === 0 || r.height === 0
        ? null
        : { x: r.left, y: r.top, width: r.width, height: r.height }
  }, [paneRef])

  useEffect(() => {
    measure()
    const el = paneRef.current
    if (!el) return
    // Guarded for non-DOM/legacy test runtimes: without ResizeObserver the cache still works, it
    // just refreshes on window resize only.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    ro?.observe(el)
    window.addEventListener('resize', measure)
    // Capture: the transform that invalidates us runs on an ANCESTOR (see the docblock).
    window.addEventListener('animationend', measure, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('animationend', measure, true)
    }
  }, [measure, paneRef])

  return useCallback(() => rectRef.current, [])
}

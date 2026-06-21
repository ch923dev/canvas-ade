import { useEffect } from 'react'
import type { RefObject } from 'react'
import { usePreviewStore } from '../../store/previewStore'
import { useOsrLivenessStore } from '../../store/osrLivenessStore'
import { bgraToRgba } from '../../lib/bgraToRgba'

// One streamed OSR frame. Derived from the (now id-keyed) preload listener so the type stays in
// lockstep with preload's OsrFrame without a cross-package import (same pattern as useOffscreenInput).
type OsrFrame = Parameters<Parameters<typeof window.api.onPreviewOsrFrame>[1]>[0]

/**
 * Drive a Browser board's offscreen preview (OSR — the sole preview engine since OS-3 Phase 5C).
 *
 * Opens an offscreen render in MAIN, paints each streamed frame into the board's
 * `<canvas>`, and closes it on unmount. The canvas is a normal DOM node inside
 * `.bb-frame`, so it clips / rounds / z-orders — the occlusion fix (ADR
 * 0002). There is NO camera-sync IPC: the canvas moves with the DOM, so the entire
 * `setBoundsBatch` rAF pump the native path needs is gone.
 *
 * OS-3 Phase 2 (2B): the window's open/close is gated on the board's `alive` flag (the
 * liveness manager's MAX_LIVE existence cap). An evicted (over-cap) board's window is
 * CLOSED — its renderer freed — but its last frame stays on the <canvas> as a frozen
 * snapshot (a "paused" badge over it); it re-opens when it climbs back into the cap. So
 * the canvas-clear is split into its OWN effect (url-change / unmount only) — the
 * lifecycle effect closes WITHOUT clearing so an evict keeps the frame.
 */
export function useOffscreenPreview(
  boardId: string,
  url: string,
  canvasRef: RefObject<HTMLCanvasElement | null>
): void {
  // 2B — the MAX_LIVE existence flag for this board. Default true so a freshly-mounted board
  // opens immediately; the manager flips it false to evict (over-cap), true to revive.
  const alive = useOsrLivenessStore((s) => s.alive[boardId] ?? true)

  // Clear the canvas on a URL change or unmount — but NOT on an evict (alive→false), which keeps
  // the frozen last frame. Its own effect (deps exclude `alive`) so the lifecycle effect can
  // close-without-clearing. A failed-load / crash clear stays in the event handler below.
  useEffect(() => {
    const clearCanvas = (): void => {
      const cv = canvasRef.current
      cv?.getContext('2d')?.clearRect(0, 0, cv.width, cv.height)
    }
    return () => clearCanvas()
  }, [boardId, url, canvasRef])

  useEffect(() => {
    if (!url || !alive) return

    // PREV-02: per-board frame queue drained once per animation frame. Frames are dirty-rect
    // PARTIAL blits, so drain ALL queued frames in order — never "keep only the latest", which
    // would drop intermediate sub-rect paints and corrupt the canvas. This only defers the blits
    // from the IPC callback to display cadence (no extra work, no dropped pixels).
    let queue: OsrFrame[] = []
    let rafId = 0
    // Reused across same-size frames (full repaints + repeated same-region dirty rects, e.g. a
    // blinking caret) so steady-state painting allocates nothing. ImageData requires
    // length === w*h*4 exactly, so only reuse when the size matches; reallocate on a size change.
    let reuseRgba: Uint8ClampedArray<ArrayBuffer> | undefined

    // Clear a stale page bitmap so it never sits OVER the board's Couldn't-load / Crashed
    // fallback. Used by the fail/crash handlers (the stream stops, leaving the last frame frozen).
    // Also drops any queued/pending frame so a stale blit can't repaint over the fallback.
    const clearCanvas = (): void => {
      queue = []
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      const cv = canvasRef.current
      cv?.getContext('2d')?.clearRect(0, 0, cv.width, cv.height)
    }

    // Blit one frame (dirty-rect aware, BGRA→RGBA swizzle). Verbatim from the old inline handler.
    const applyFrame = (
      cv: HTMLCanvasElement,
      ctx: CanvasRenderingContext2D,
      f: OsrFrame
    ): void => {
      // OS-3 Phase 2 (2C) — dirty-rect aware. A full repaint reports dirty == the whole frame;
      // a partial paint covers only the changed sub-rect.
      const isFull =
        f.dirty.x === 0 &&
        f.dirty.y === 0 &&
        f.dirty.width === f.full.width &&
        f.dirty.height === f.full.height
      // The <canvas> tracks the FULL frame size; setting cv.width/height also CLEARS it. A
      // partial frame can't fill a freshly-cleared canvas, so only adopt a new size on a FULL
      // frame — MAIN guarantees the first frame after any resize is full (invalidate()). A
      // stray partial frame for a not-yet-sized canvas is dropped (never happens in practice).
      if (cv.width !== f.full.width || cv.height !== f.full.height) {
        if (!isFull) return
        cv.width = f.full.width
        cv.height = f.full.height
      }
      // NativeImage.toBitmap() is BGRA; ImageData is RGBA → swap R/B. The fast 32-bit-word
      // swizzle (bgraToRgba) replaces the old per-byte loop (~4× fewer typed-array ops). Blit
      // ONLY the dirty sub-rect; the rest of the canvas keeps the previous frame's pixels.
      const src = f.buffer instanceof Uint8Array ? f.buffer : new Uint8Array(f.buffer)
      if (!reuseRgba || reuseRgba.length !== src.length)
        reuseRgba = new Uint8ClampedArray(src.length)
      const rgba = bgraToRgba(src, reuseRgba)
      ctx.putImageData(new ImageData(rgba, f.dirty.width, f.dirty.height), f.dirty.x, f.dirty.y)
    }

    const drain = (): void => {
      rafId = 0
      const frames = queue
      queue = []
      if (frames.length === 0) return
      const cv = canvasRef.current
      const ctx = cv?.getContext('2d')
      if (!cv || !ctx) return
      for (const f of frames) applyFrame(cv, ctx, f)
    }

    void window.api.openOsrPreview({ id: boardId, url })
    // Show "Connecting…" under the (still-transparent) canvas until the first frame /
    // did-finish-load promotes to connected. previewStore is the same runtime the board's
    // DeviceContent reads this, the same runtime the board chrome renders from.
    usePreviewStore.getState().patch(boardId, { status: 'connecting', error: null })
    // MAIN emits load/fail/navigate/crash on the `preview:event` channel (previewOsr.ts). Consume
    // them here, slimly — an OSR board exists while its canvas is mounted, so there is no
    // existence/eviction bookkeeping to gate against (unlike the deleted native consumer).
    const offEvent = window.api.onPreviewEvent((ev) => {
      if (ev.id !== boardId) return
      const ps = usePreviewStore.getState()
      const cur = ps.byId[boardId]?.status
      if (ev.type === 'did-start-navigation') {
        if (cur === 'load-failed' || cur === 'crashed')
          ps.patch(boardId, { status: 'connecting', error: null })
      } else if (ev.type === 'did-finish-load') {
        if (cur !== 'load-failed')
          ps.patch(boardId, { status: 'connected', liveUrl: ev.url, error: null })
      } else if (ev.type === 'did-navigate') {
        // BUG-004: an in-page route committed after a prior failure carries `recovered`
        // (main cleared its `failed` latch); lift a stale load-failed/crashed back to
        // connected here too, since an in-page nav fires no did-finish-load to promote it.
        const recovered = (ev as { recovered?: boolean }).recovered === true
        if (recovered && (cur === 'load-failed' || cur === 'crashed')) {
          ps.patchIfPresent(boardId, {
            status: 'connected',
            liveUrl: ev.url,
            canGoBack: ev.canGoBack,
            canGoForward: ev.canGoForward,
            error: null
          })
        } else {
          ps.patchIfPresent(boardId, {
            liveUrl: ev.url,
            canGoBack: ev.canGoBack,
            canGoForward: ev.canGoForward
          })
        }
      } else if (ev.type === 'did-fail-load') {
        ps.patchIfPresent(boardId, { status: 'load-failed', error: ev.errorDescription })
        // No more frames will arrive; drop the stale bitmap so the "Couldn't load + Reload"
        // fallback (under the canvas) is visible instead of the last good page.
        clearCanvas()
      } else if (ev.type === 'render-process-gone') {
        ps.patchIfPresent(boardId, { status: 'crashed', error: ev.reason })
        // A crashed renderer paints no more frames; clear the stale bitmap so the board's
        // "Preview crashed + Reload" fallback (under the canvas) becomes visible.
        clearCanvas()
      }
    })
    // PREV-02: the shared frame listener dispatches by board id, so this handler only ever sees
    // THIS board's frames (no per-frame id check). Queue + rAF-coalesce the blits (drain above).
    const off = window.api.onPreviewOsrFrame(boardId, (f) => {
      queue.push(f)
      if (!rafId) rafId = requestAnimationFrame(drain)
    })
    return () => {
      off()
      offEvent()
      if (rafId) cancelAnimationFrame(rafId)
      queue = []
      // Close the offscreen window. On a URL change the separate clear effect wipes the canvas;
      // on an EVICT (alive→false) it does NOT, so the frozen last frame stays as a snapshot.
      void window.api.closeOsrPreview(boardId)
    }
  }, [boardId, url, alive, canvasRef])

  // FIND-011: drop this board's previewStore entry when the board UNMOUNTS (a deletion or project
  // switch unmounts the BoardNode). The lifecycle effect above re-runs on every url/alive change, so
  // it can't own this clear without wrongly wiping the entry on each navigation/evict. Without it the
  // `byId` map grows monotonically per browser-board mount. Mirrors the terminal/widget store
  // unmount-clear pattern (useTerminalSpawn / useOsrWidgetEvents).
  useEffect(() => () => usePreviewStore.getState().clear(boardId), [boardId])
}

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { usePreviewStore } from '../../store/previewStore'
import { useOsrLivenessStore } from '../../store/osrLivenessStore'

// One streamed OSR frame. Derived from the (now id-keyed) preload listener so the type stays in
// lockstep with preload's OsrFrame without a cross-package import (same pattern as useOffscreenInput).
type OsrFrame = Parameters<Parameters<typeof window.api.onPreviewOsrFrame>[1]>[0]

// SLICE-006: the worker swizzles BGRA→RGBA off the main thread and transfers the RGBA buffer back,
// echoing `gen` so a response for a frame posted before a clear (fail/crash/url-change) is dropped.
interface OsrSwizzleResponse {
  gen: number
  buffer: ArrayBuffer
  dirty: { x: number; y: number; width: number; height: number }
  full: { width: number; height: number }
}

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
 *
 * SLICE-006: the BGRA→RGBA swizzle runs in a dedicated worker (`osrBlitWorker`), not on the main
 * thread. Each frame's BGRA buffer is transferred to the worker (zero-copy); the worker swizzles and
 * transfers the RGBA back; the cheap GPU-backed `putImageData` then runs on the main-thread 2D canvas
 * here. The canvas stays a normal main-thread canvas (not an OffscreenCanvas) so the clear / evict /
 * `osrCanvasNonBlank` paths keep reading it via `getContext('2d')` unchanged.
 */
export function useOffscreenPreview(
  boardId: string,
  url: string,
  canvasRef: RefObject<HTMLCanvasElement | null>
): void {
  // 2B — the MAX_LIVE existence flag for this board. Default true so a freshly-mounted board
  // opens immediately; the manager flips it false to evict (over-cap), true to revive.
  const alive = useOsrLivenessStore((s) => s.alive[boardId] ?? true)

  // The swizzle worker (lives for the whole board mount; survives url/alive changes) + a generation
  // counter bumped on every clear so an in-flight worker response can't repaint over a cleared canvas.
  const workerRef = useRef<Worker | null>(null)
  const genRef = useRef(0)

  // Worker lifecycle (mount-only): a persistent `message` handler blits each swizzled response onto
  // the main-thread canvas, dropping stale-generation responses. (No React.StrictMode in this app, so
  // this runs once per mount — no listener churn / double worker.)
  useEffect(() => {
    const worker = new Worker(new URL('./osrBlitWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (e: MessageEvent<OsrSwizzleResponse>): void => {
      const { gen, buffer, dirty, full } = e.data
      // M6: return the RGBA buffer to the worker's pool on EVERY exit path. The early drops below
      // (stale gen · no canvas/ctx · a non-full frame on a size change) fire on exactly the churn
      // that bumps `gen` (url change / fail / crash / unmount / evict), so returning ONLY after
      // putImageData would bleed the free-list dry. putImageData copies synchronously, so the buffer
      // is free the instant it returns; the transfer neuters our handle (we never read it after).
      const recycle = (): void => {
        workerRef.current?.postMessage({ returnBuffer: buffer }, [buffer])
      }
      if (gen !== genRef.current) return recycle() // posted before a clear → drop (canvas wiped since)
      const cv = canvasRef.current
      const ctx = cv?.getContext('2d')
      if (!cv || !ctx) return recycle()
      // OS-3 Phase 2 (2C) — dirty-rect aware. A full repaint reports dirty == the whole frame; a
      // partial paint covers only the changed sub-rect.
      const isFull =
        dirty.x === 0 && dirty.y === 0 && dirty.width === full.width && dirty.height === full.height
      // The <canvas> tracks the FULL frame size; setting cv.width/height also CLEARS it. A partial
      // frame can't fill a freshly-cleared canvas, so only adopt a new size on a FULL frame — MAIN
      // guarantees the first frame after any resize is full (invalidate()).
      if (cv.width !== full.width || cv.height !== full.height) {
        if (!isFull) return recycle()
        cv.width = full.width
        cv.height = full.height
      }
      // `buffer` is the worker-swizzled RGBA (transferred back); wrap it (no copy) and blit ONLY the
      // dirty sub-rect — the rest of the canvas keeps the previous frame's pixels.
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(buffer), dirty.width, dirty.height),
        dirty.x,
        dirty.y
      )
      recycle()
    }
    return () => {
      workerRef.current = null
      worker.terminate()
    }
  }, [canvasRef])

  // Clear the canvas on a URL change or unmount — but NOT on an evict (alive→false), which keeps
  // the frozen last frame. Its own effect (deps exclude `alive`) so the lifecycle effect can
  // close-without-clearing. A failed-load / crash clear stays in the event handler below.
  useEffect(() => {
    const cv = canvasRef.current // captured at setup (same element across url changes) for cleanup
    return () => {
      genRef.current += 1 // invalidate in-flight worker responses for the page being torn down
      cv?.getContext('2d')?.clearRect(0, 0, cv.width, cv.height)
    }
  }, [boardId, url, canvasRef])

  useEffect(() => {
    if (!url || !alive) return

    // Clear a stale page bitmap so it never sits OVER the board's Couldn't-load / Crashed fallback.
    // Used by the fail/crash handlers (the stream stops, leaving the last frame frozen). The gen bump
    // also drops any worker response still in flight so a stale blit can't repaint over the fallback.
    const clearCanvas = (): void => {
      genRef.current += 1
      const cv = canvasRef.current
      cv?.getContext('2d')?.clearRect(0, 0, cv.width, cv.height)
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
    // PREV-02: the shared frame listener dispatches by board id, so this handler only ever sees THIS
    // board's frames. SLICE-006: hand the BGRA buffer to the swizzle worker (transferred → zero-copy);
    // the worker's response (above) does the main-thread putImageData. No main-thread swizzle.
    const off = window.api.onPreviewOsrFrame(boardId, (f: OsrFrame) => {
      const worker = workerRef.current
      if (!worker) return
      // Transfer the BGRA ArrayBuffer when this view owns it whole (the common case — IPC delivers a
      // fresh, fully-owned buffer per frame); otherwise hand the worker a compact copy. Either way the
      // swizzle leaves the main thread.
      const ownsWhole =
        f.buffer.byteOffset === 0 && f.buffer.byteLength === f.buffer.buffer.byteLength
      const ab = ownsWhole ? f.buffer.buffer : f.buffer.slice().buffer
      worker.postMessage({ gen: genRef.current, buffer: ab, dirty: f.dirty, full: f.full }, [
        ab as Transferable
      ])
    })
    return () => {
      off()
      offEvent()
      genRef.current += 1 // drop in-flight responses for the closing window
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

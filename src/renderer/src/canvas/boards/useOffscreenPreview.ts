import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * SPIKE (feat/preview-offscreen-spike): drive a Browser board's offscreen preview.
 *
 * Opens an offscreen render in MAIN, paints each streamed frame into the board's
 * `<canvas>`, and closes it on unmount. The canvas is a normal DOM node inside
 * `.bb-frame`, so it clips / rounds / z-orders — the occlusion fix under test (ADR
 * 0002). There is NO camera-sync IPC: the canvas moves with the DOM, so the entire
 * `setBoundsBatch` rAF pump the native path needs is gone.
 *
 * First slice = frames only (spec M1/M2). Input forwarding (M3) and DPR/responsive
 * sizing (M1/M4) are later increments. A URL change re-opens (close → open).
 */
export function useOffscreenPreview(
  boardId: string,
  url: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled || !url) return
    void window.api.openOsrPreview({ id: boardId, url })
    const off = window.api.onPreviewOsrFrame((f) => {
      if (f.id !== boardId) return
      const cv = canvasRef.current
      if (!cv) return
      const ctx = cv.getContext('2d')
      if (!ctx) return
      if (cv.width !== f.width || cv.height !== f.height) {
        cv.width = f.width
        cv.height = f.height
      }
      // NativeImage.getBitmap() is BGRA; ImageData is RGBA → swap R/B per pixel. This
      // per-frame swap is itself an M2 throughput factor (a GPU path could avoid it) —
      // noted for the spike's throughput measurement.
      const src = f.buffer instanceof Uint8Array ? f.buffer : new Uint8Array(f.buffer)
      const rgba = new Uint8ClampedArray(src.length)
      for (let i = 0; i < src.length; i += 4) {
        rgba[i] = src[i + 2]
        rgba[i + 1] = src[i + 1]
        rgba[i + 2] = src[i]
        rgba[i + 3] = src[i + 3]
      }
      ctx.putImageData(new ImageData(rgba, f.width, f.height), 0, 0)
    })
    return () => {
      off()
      void window.api.closeOsrPreview(boardId)
    }
  }, [boardId, url, enabled, canvasRef])
}

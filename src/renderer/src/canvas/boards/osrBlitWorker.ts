/**
 * SLICE-006 — OSR swizzle worker. Runs the BGRA→RGBA channel swap OFF the renderer main thread.
 *
 * The renderer posts each streamed OSR frame's BGRA buffer (transferred → zero-copy); this worker
 * swizzles it to RGBA and transfers the result back. The renderer then does the cheap, GPU-backed
 * `putImageData` on its 2D `<canvas>`. So the per-frame swizzle — ~4.8 ms/frame for a full S=2
 * desktop frame, ~58% of a core across 4 live boards — no longer competes with React/layout on the
 * main thread. (SLICE-005 already shrank the COMMON case to tiny dirty rects; this moves the cost
 * for the full-repaint case — video / animation / continuous scroll — off the main thread.)
 *
 * The canvas stays a normal main-thread 2D canvas (NOT an OffscreenCanvas), so the host's
 * lifecycle (clear on fail/crash/url-change, evict-keeps-frozen-frame) and the `osrCanvasNonBlank`
 * test seam keep reading it via `getContext('2d')` unchanged. `gen` is echoed back so the host can
 * drop responses for frames posted before a clear.
 *
 * Pure swizzle (reuses the unit-tested `bgraToRgba`); no canvas / DOM / eval → loads cleanly under
 * the main window's `script-src 'self'` CSP as a same-origin module worker.
 */
import { bgraToRgba } from '../../lib/bgraToRgba'

interface SwizzleRequest {
  gen: number
  buffer: ArrayBuffer
  dirty: { x: number; y: number; width: number; height: number }
  full: { width: number; height: number }
}

// `postMessage` is typed as Window.postMessage under the dom lib; in a worker it is the
// DedicatedWorkerGlobalScope overload (message, transfer). Cast to that shape for the transfer list.
const post = postMessage as (message: unknown, transfer: Transferable[]) => void

addEventListener('message', (e: MessageEvent<SwizzleRequest>) => {
  // This is a DEDICATED worker: messages can only originate from the renderer that spawned it
  // (same-origin by construction — `e.origin` is "" for worker messages, so an origin check is
  // inapplicable). Validate the message SHAPE instead, so a malformed post is dropped rather than
  // throwing in the swizzle below (defense-in-depth; the only real sender posts the typed request).
  const msg = e.data
  if (!msg || !(msg.buffer instanceof ArrayBuffer)) return
  const { gen, buffer, dirty, full } = msg
  // Fresh RGBA output (off the main thread); the transferred BGRA input is GC'd here.
  const rgba = bgraToRgba(new Uint8Array(buffer))
  post({ gen, buffer: rgba.buffer, dirty, full }, [rgba.buffer])
})

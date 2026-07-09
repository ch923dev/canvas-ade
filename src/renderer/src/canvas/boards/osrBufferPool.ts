/**
 * M6 — a tiny size-keyed ArrayBuffer free-list for the OSR blit worker.
 *
 * The worker swizzles each streamed frame's BGRA input into an RGBA output buffer. Allocating a
 * fresh ~16 MB (S=2 desktop) output every frame is ~1 GB/s of `Uint8ClampedArray` garbage under
 * continuous motion (video / scroll). Instead the worker takes an output buffer from this pool,
 * and the renderer main thread RETURNS it after `putImageData` (which copies the pixels into the
 * canvas, so the buffer is free the instant it returns). This is genuinely zero-copy — the
 * main↔worker transfer is within ONE renderer process (unlike the main↔renderer IPC, which crosses
 * a process boundary regardless of transfer; see STRUCTURAL_PLAN §4.2).
 *
 * Keyed by EXACT byte length: `ImageData` requires `data.length === width·height·4`, so a reused
 * buffer must match the frame's dirty-rect size exactly. It therefore recycles only when successive
 * frames share a size (`dirty == full` — the full-repaint / continuous-motion case this targets);
 * varying dirty rects simply miss and allocate. `take` allocates-on-empty, so a lost or dropped
 * buffer is self-healing (the pool never blocks / stalls the pipeline).
 */
export interface BufferPool {
  /** An ArrayBuffer of exactly `byteLength` — reused from the free-list when available, else fresh. */
  take(byteLength: number): ArrayBuffer
  /** Return a buffer for reuse. Dropped (left to GC) once its size bucket is at capacity. */
  give(buffer: ArrayBuffer): void
}

export function createBufferPool(perSize = 3): BufferPool {
  const free = new Map<number, ArrayBuffer[]>()
  return {
    take(byteLength) {
      const reused = free.get(byteLength)?.pop()
      return reused ?? new ArrayBuffer(byteLength)
    },
    give(buffer) {
      const bucket = free.get(buffer.byteLength) ?? []
      if (bucket.length < perSize) {
        bucket.push(buffer)
        free.set(buffer.byteLength, bucket)
      }
      // else drop — bounds memory when frame sizes churn (each held buffer is up to ~16 MB)
    }
  }
}

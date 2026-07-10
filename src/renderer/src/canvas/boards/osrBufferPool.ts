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
 *
 * Bounded retention (H5 review): keying by exact byte length means a long session that streams many
 * DISTINCT dirty-rect sizes (continuous zoom settles, preset switches, varying dirty-rect geometry)
 * would otherwise add a new PERMANENT map key per size — each retaining up to `perSize` buffers of
 * tens of MB — so retained memory would grow monotonically, the opposite of the GC-pressure win.
 * `maxBytes` caps TOTAL retained bytes across all buckets: a `give` first LRU-evicts the
 * least-recently-used size bucket(s) until the incoming buffer fits, and both `take` and `give`
 * re-touch their size so the HOT (actively streamed) size is never the eviction victim.
 */
export interface BufferPool {
  /** An ArrayBuffer of exactly `byteLength` — reused from the free-list when available, else fresh. */
  take(byteLength: number): ArrayBuffer
  /** Return a buffer for reuse. Dropped (left to GC) at the per-size cap or the total-byte budget. */
  give(buffer: ArrayBuffer): void
}

export function createBufferPool(perSize = 3, maxBytes = 64 * 1024 * 1024): BufferPool {
  // Map insertion order == LRU order: take/give re-insert the touched size so it becomes
  // most-recently-used; eviction drops `free.keys().next()` (the least-recently-used size).
  const free = new Map<number, ArrayBuffer[]>()
  let retained = 0

  const touch = (key: number, bucket: ArrayBuffer[]): void => {
    free.delete(key)
    free.set(key, bucket)
  }

  return {
    take(byteLength) {
      const bucket = free.get(byteLength)
      const reused = bucket?.pop()
      if (!reused) return new ArrayBuffer(byteLength)
      retained -= reused.byteLength
      if (bucket!.length) touch(byteLength, bucket!)
      else free.delete(byteLength)
      return reused
    },
    give(buffer) {
      const size = buffer.byteLength
      if (size > maxBytes) return // a single buffer larger than the whole budget is never retained
      const bucket = free.get(size) ?? []
      if (bucket.length >= perSize) return // per-size depth cap — drop
      // Evict LRU size buckets (oldest first) until this buffer fits the byte budget. SKIP the size
      // we're adding to (never evict our own about-to-be-MRU bucket) and keep going — so when the
      // incoming size is itself the LRU, an evictable YOUNGER bucket still makes room instead of the
      // give bailing and dropping a buffer that would have fit.
      if (retained + size > maxBytes) {
        for (const key of [...free.keys()]) {
          if (retained + size <= maxBytes) break
          if (key === size) continue
          for (const b of free.get(key)!) retained -= b.byteLength
          free.delete(key)
        }
      }
      if (retained + size > maxBytes) return // no evictable room even after all other buckets — drop
      bucket.push(buffer)
      retained += size
      touch(size, bucket)
    }
  }
}

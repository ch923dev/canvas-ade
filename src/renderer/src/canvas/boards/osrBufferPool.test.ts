import { describe, it, expect } from 'vitest'
import { createBufferPool } from './osrBufferPool'

// M6: the OSR blit worker's RGBA output free-list. Pins the reuse/size-keying/bounding contract the
// worker + useOffscreenPreview return-transfer rely on.
describe('createBufferPool (M6 OSR blit buffer pool)', () => {
  it('take on an empty pool allocates a fresh buffer of the exact size', () => {
    const pool = createBufferPool()
    const ab = pool.take(16)
    expect(ab).toBeInstanceOf(ArrayBuffer)
    expect(ab.byteLength).toBe(16)
  })

  it('give → take of the SAME size reuses the same buffer (no allocation)', () => {
    const pool = createBufferPool()
    const a = pool.take(64)
    pool.give(a)
    expect(pool.take(64)).toBe(a) // identity — the pooled buffer came back
  })

  it('take of a DIFFERENT size never reuses (size-keyed; ImageData needs exact bytes)', () => {
    const pool = createBufferPool()
    const a = pool.take(64)
    pool.give(a)
    const b = pool.take(128)
    expect(b).not.toBe(a)
    expect(b.byteLength).toBe(128)
    expect(pool.take(64)).toBe(a) // the 64-byte buffer is still there for a 64 request
  })

  it('bounds the free-list per size (drops gives beyond capacity — up to ~16 MB each)', () => {
    const pool = createBufferPool(2) // cap 2 per size
    const a = pool.take(32)
    const b = pool.take(32)
    const c = pool.take(32)
    pool.give(a)
    pool.give(b)
    pool.give(c) // bucket already at cap 2 → c dropped (GC reclaims)

    expect(pool.take(32)).toBe(b) // LIFO
    expect(pool.take(32)).toBe(a)
    const fresh = pool.take(32) // pool drained → fresh alloc (c was NOT retained)
    expect(fresh).not.toBe(a)
    expect(fresh).not.toBe(b)
    expect(fresh).not.toBe(c)
    expect(fresh.byteLength).toBe(32)
  })

  it('allocate-on-empty: take always returns a usable buffer (never blocks / stalls the pipeline)', () => {
    const pool = createBufferPool()
    expect(pool.take(8).byteLength).toBe(8)
    expect(pool.take(8).byteLength).toBe(8) // still allocates — a drained pool degrades, never fails
  })
})

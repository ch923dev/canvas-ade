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

  it('bounds TOTAL retained bytes across DISTINCT sizes (LRU-evicts the least-recently-used size)', () => {
    // The bug this guards (H5 review): keyed by exact byte length, a churn of distinct dirty-rect
    // sizes would add a new PERMANENT key each, growing retained memory monotonically. The byte
    // budget caps it — the oldest size bucket is evicted to make room.
    const pool = createBufferPool(3, 100) // 100-byte total budget
    const a = new ArrayBuffer(40)
    const b = new ArrayBuffer(50)
    const c = new ArrayBuffer(30)
    pool.give(a) // retained 40
    pool.give(b) // retained 90
    pool.give(c) // 90 + 30 > 100 → evict oldest size (40, a's bucket) → 50, then add c → 80
    expect(pool.take(40)).not.toBe(a) // the size-40 bucket was LRU-evicted → fresh alloc
    expect(pool.take(50)).toBe(b) // the survivors are still pooled
    expect(pool.take(30)).toBe(c)
  })

  it('never evicts the HOT size — take re-touches it to most-recently-used', () => {
    const pool = createBufferPool(3, 100)
    const hot = new ArrayBuffer(40)
    const other = new ArrayBuffer(50)
    pool.give(hot) // {40} retained 40
    pool.give(other) // {40,50} retained 90
    expect(pool.take(40)).toBe(hot) // use the hot size (empties its bucket)…
    pool.give(hot) // …and return it → size 40 is now most-recently-used, 50 is the LRU
    pool.give(new ArrayBuffer(30)) // 90 + 30 > 100 → evicts the LRU (50/other), NOT the hot 40
    expect(pool.take(40)).toBe(hot) // hot survived the eviction
    expect(pool.take(50)).not.toBe(other) // the stale (LRU) size was the one dropped
  })

  it('when the incoming size IS the LRU bucket, skips it and evicts a YOUNGER bucket (no bail)', () => {
    // Regression (H5 re-review): eviction must skip the size it is adding to and keep evicting the
    // next-oldest bucket — not break out and drop a buffer that a younger, evictable bucket fits.
    const pool = createBufferPool(3, 100)
    const s1 = new ArrayBuffer(40) // size 40 becomes the OLDEST (LRU) key
    const other = new ArrayBuffer(50) // size 50 is younger
    pool.give(s1) // retained 40
    pool.give(other) // retained 90
    const s2 = new ArrayBuffer(40) // give size 40 again: the LRU key (40) == the incoming size
    pool.give(s2) // 90 + 40 > 100 → must skip the 40 bucket, evict the younger 50, then retain s2
    expect(pool.take(50)).not.toBe(other) // the younger, evictable bucket was dropped to make room
    expect(pool.take(40)).toBe(s2) // the incoming size was retained (LIFO)…
    expect(pool.take(40)).toBe(s1) // …and its earlier buffer survived too — the give did NOT bail
  })
})

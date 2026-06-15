import { describe, it, expect } from 'vitest'
import { bgraToRgba } from './bgraToRgba'

describe('bgraToRgba', () => {
  it('swaps R and B, preserves G and A (single pixel)', () => {
    // BGRA bytes B=0x10 G=0x20 R=0x30 A=0x40 → RGBA R=0x30 G=0x20 B=0x10 A=0x40
    const out = bgraToRgba(new Uint8Array([0x10, 0x20, 0x30, 0x40]))
    expect(Array.from(out)).toEqual([0x30, 0x20, 0x10, 0x40])
  })

  it('handles multiple pixels', () => {
    const src = new Uint8Array([
      0x10,
      0x20,
      0x30,
      0x40, // px0
      0x01,
      0x02,
      0x03,
      0xff // px1
    ])
    expect(Array.from(bgraToRgba(src))).toEqual([0x30, 0x20, 0x10, 0x40, 0x03, 0x02, 0x01, 0xff])
  })

  it('round-trips (swizzle twice → original)', () => {
    const src = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd])
    const once = bgraToRgba(src)
    const twice = bgraToRgba(new Uint8Array(once.buffer.slice(0)))
    expect(Array.from(twice)).toEqual(Array.from(src))
  })

  it('reuses a provided output buffer (no realloc)', () => {
    const out = new Uint8ClampedArray(4)
    const ret = bgraToRgba(new Uint8Array([0x10, 0x20, 0x30, 0x40]), out)
    expect(ret).toBe(out)
    expect(Array.from(out)).toEqual([0x30, 0x20, 0x10, 0x40])
  })

  it('allocates when the provided buffer is too small', () => {
    const tooSmall = new Uint8ClampedArray(2)
    const ret = bgraToRgba(new Uint8Array([0x10, 0x20, 0x30, 0x40]), tooSmall)
    expect(ret).not.toBe(tooSmall)
    expect(Array.from(ret)).toEqual([0x30, 0x20, 0x10, 0x40])
  })

  it('matches via the unaligned fallback path (nonzero byteOffset)', () => {
    // Force the byte-loop fallback: a view starting at an unaligned byteOffset.
    const backing = new ArrayBuffer(16)
    const view = new Uint8Array(backing, 2, 8) // byteOffset 2 → not 4-aligned
    view.set([0x10, 0x20, 0x30, 0x40, 0x01, 0x02, 0x03, 0xff])
    expect(Array.from(bgraToRgba(view))).toEqual([0x30, 0x20, 0x10, 0x40, 0x03, 0x02, 0x01, 0xff])
  })

  it('empty buffer → empty result', () => {
    expect(bgraToRgba(new Uint8Array(0)).length).toBe(0)
  })
})

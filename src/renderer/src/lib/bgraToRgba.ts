/**
 * OS-3 Phase 2 (M2 / 2C) — fast BGRA→RGBA swizzle.
 *
 * Electron's `nativeImage.toBitmap()` is BGRA (native byte order); a 2D-canvas `ImageData`
 * is RGBA, so the R and B bytes must swap. The naive path is a per-BYTE loop (4 typed-array
 * reads + 4 writes per pixel); this does it per 32-bit WORD — 1 read + 1 write per pixel — by
 * keeping the G and A bytes in place and swapping only R↔B. ~4× fewer typed-array accesses,
 * which matters at S=2 supersample (a 1280 desktop board is ~4M pixels/frame at 30fps).
 *
 * Pure + unit-tested. Little-endian only (every build target is LE: x64 + arm64 across
 * win/mac/linux). On the effectively-nonexistent big-endian case — or an unaligned / odd-
 * length buffer (e.g. a pool-backed Node Buffer view) — it falls back to the correct per-byte
 * loop. Operates on the WHOLE buffer it is handed; for dirty-rect frames the caller passes
 * only the cropped region's buffer.
 */

/** True on little-endian hosts (probe once at module load). */
const IS_LITTLE_ENDIAN = ((): boolean => {
  const probe = new Uint16Array([0x0102])
  return new Uint8Array(probe.buffer)[0] === 0x02
})()

/**
 * Swizzle `src` (BGRA bytes) into RGBA. Writes into `out` when supplied and large enough
 * (re-used across frames to avoid per-frame allocation), else allocates a fresh array.
 * Returns the destination, typed over a plain `ArrayBuffer` so it drops straight into the
 * `ImageData` constructor (which rejects a `SharedArrayBuffer`-backed array).
 */
export function bgraToRgba(
  src: Uint8Array,
  out?: Uint8ClampedArray<ArrayBuffer>
): Uint8ClampedArray<ArrayBuffer> {
  const dst = out && out.length >= src.length ? out : new Uint8ClampedArray(src.length)
  const aligned = (src.byteOffset & 3) === 0 && (dst.byteOffset & 3) === 0 && src.length % 4 === 0
  if (IS_LITTLE_ENDIAN && aligned) {
    const words = src.length >>> 2
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words)
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, words)
    for (let i = 0; i < words; i++) {
      const px = s32[i]
      // keep G (bits 8-15) + A (bits 24-31); move B (low byte) → bits 16-23; R → low byte.
      d32[i] = (px & 0xff00ff00) | ((px & 0x000000ff) << 16) | ((px >>> 16) & 0x000000ff)
    }
    return dst
  }
  // Fallback: per-byte (big-endian host, or an unaligned/odd-length buffer).
  for (let i = 0; i + 3 < src.length; i += 4) {
    dst[i] = src[i + 2]
    dst[i + 1] = src[i + 1]
    dst[i + 2] = src[i]
    dst[i + 3] = src[i + 3]
  }
  return dst
}

/**
 * Backdrop wallpaper import accept-lists — the single renderer source of truth
 * (spec section 3). Both the picker's file <input> gate (BackdropPicker) and the
 * Blob-URL loader's MIME map (useBackdropMedia) import from here, so the two can
 * never drift apart (they used to be hand-mirrored).
 *
 * MAIN re-validates independently by design (the renderer is untrusted) via
 * `ASSET_EXTS` in `src/main/projectStore.ts` — a deliberate cross-trust-boundary
 * duplication, NOT a shared import. The drift between THESE renderer lists and
 * MAIN's is the real hazard (it shipped a broken video import once, addendum
 * section 6), so `src/main/assetExtsParity.test.ts` (S11b) asserts every ext here
 * is a subset of MAIN's set — a new ext added to one side fails a unit test
 * instead of a user's import.
 *
 * Pure module: zero React / DOM / Node deps, so the node-env parity test can
 * import it across the process boundary without dragging the renderer in.
 */

/** Still-image wallpaper extensions (lower-case, no dot). */
export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif']
/** Video wallpaper extensions (lower-case, no dot). */
export const VIDEO_EXTS: readonly string[] = ['webm', 'mp4']

/** ext -> MIME for the Blob the loader hands to <img>/<video>. Keys MUST cover
 *  every IMAGE_EXTS + VIDEO_EXTS member (asserted by the parity test). */
export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  webm: 'video/webm',
  mp4: 'video/mp4'
}

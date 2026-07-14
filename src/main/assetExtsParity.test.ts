import { describe, it, expect } from 'vitest'
import { ASSET_EXTS } from './projectStore'
import { IMAGE_EXTS, VIDEO_EXTS, MIME_BY_EXT } from '../renderer/src/canvas/backdrop/acceptExts'

/**
 * S11b — backdrop accept-list drift guard (addendum-presets.md section 6). The renderer's wallpaper
 * accept lists and MAIN's `ASSET_EXTS` are duplicated ACROSS the trust boundary on purpose. The
 * hazard is drift between them: PR 1 added video to both renderer lists but not MAIN's, so the first
 * real `.webm` import threw at the IPC boundary. This node-env test imports the live constants from
 * both sides so the next ext added to one side fails here instead of a user's import.
 *
 * NOTE (#346): `ASSET_EXTS` is the backdrop-picker MEDIA allow-list, no longer the `writeAsset` gate
 * — that widened to a safe alphanumeric slug (`SAFE_EXT_RE`) so card attachments can be any file. So
 * this guards the picker↔media-list relationship, not "writability" (any safe ext is now writable).
 */
describe('backdrop asset-ext parity (renderer picker lists subset of MAIN media list)', () => {
  const rendererExts = [...IMAGE_EXTS, ...VIDEO_EXTS, ...Object.keys(MIME_BY_EXT)]

  it('every renderer picker ext is in MAIN ASSET_EXTS media allow-list (backdrop drift guard)', () => {
    const orphans = rendererExts.filter((e) => !ASSET_EXTS.has(e))
    expect(
      orphans,
      `renderer picker exts absent from MAIN ASSET_EXTS: ${orphans.join(', ')}`
    ).toEqual([])
  })

  it('the two renderer lists agree: MIME_BY_EXT covers exactly IMAGE_EXTS + VIDEO_EXTS', () => {
    const declared = [...IMAGE_EXTS, ...VIDEO_EXTS].sort()
    const mimed = Object.keys(MIME_BY_EXT).sort()
    expect(mimed, 'a picker-accepted ext has no MIME mapping (or vice versa)').toEqual(declared)
  })

  it('all extensions are lower-case, dot-free (matches MAIN normalization)', () => {
    for (const e of rendererExts) expect(e, `ext "${e}"`).toMatch(/^[a-z0-9]+$/)
  })

  it('video exts map to video/* MIME (the loader keys the <video> render path off this)', () => {
    for (const e of VIDEO_EXTS) expect(MIME_BY_EXT[e], e).toMatch(/^video\//)
  })
})

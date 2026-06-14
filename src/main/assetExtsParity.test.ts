import { describe, it, expect } from 'vitest'
import { ASSET_EXTS } from './projectStore'
import { IMAGE_EXTS, VIDEO_EXTS, MIME_BY_EXT } from '../renderer/src/canvas/backdrop/acceptExts'

/**
 * S11b — accept-list drift guard (addendum-presets.md section 6). The renderer's
 * wallpaper accept lists and MAIN's `ASSET_EXTS` are duplicated ACROSS the trust
 * boundary on purpose (MAIN re-validates the untrusted renderer). The hazard is
 * drift: PR 1 added video to both renderer lists but not MAIN's, so the first real
 * `.webm` import threw `writeAsset: unsupported ext webm` at the IPC boundary. This
 * node-env test imports the live constants from both sides so the next ext added to
 * one side fails here instead of a user's import.
 */
describe('backdrop asset-ext parity (renderer accept lists subset of MAIN)', () => {
  const rendererExts = [...IMAGE_EXTS, ...VIDEO_EXTS, ...Object.keys(MIME_BY_EXT)]

  it('every renderer-accepted ext is writable by MAIN (subset of ASSET_EXTS)', () => {
    const orphans = rendererExts.filter((e) => !ASSET_EXTS.has(e))
    expect(orphans, `renderer accepts exts MAIN would reject: ${orphans.join(', ')}`).toEqual([])
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

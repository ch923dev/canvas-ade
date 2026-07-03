import { describe, it, expect } from 'vitest'
import { dirHash, sanitizeThumbRect, pngDataUrl, buildThumbsMap } from './projectThumbs'

// Phase 4b (project dock) — the pure thumbnail-cache bits. The Electron capture/IPC layer is
// exercised by e2e/projectDock.e2e.ts; here we pin the file-key, rect-validation, and
// map-assembly contracts the handlers are thin wrappers over.

describe('dirHash', () => {
  it('is stable for the same dir and distinct across dirs', () => {
    const a = dirHash('C:\\work\\alpha')
    expect(a).toBe(dirHash('C:\\work\\alpha'))
    expect(a).not.toBe(dirHash('C:\\work\\beta'))
  })

  it('is a plain hex filename fragment (safe as <hash>.png on any FS)', () => {
    expect(dirHash('Z:\\Canvas ADE\\spaced path')).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('sanitizeThumbRect', () => {
  it('rounds fractional CSS-pixel coords to integers', () => {
    expect(sanitizeThumbRect({ x: 0.4, y: 10.6, width: 800.2, height: 600.7 })).toEqual({
      x: 0,
      y: 11,
      width: 800,
      height: 601
    })
  })

  it('clamps negative origins to 0 (a rect can start above/left of the viewport)', () => {
    expect(sanitizeThumbRect({ x: -5, y: -3, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    })
  })

  it('rejects non-objects, missing/non-finite fields, and degenerate sizes', () => {
    expect(sanitizeThumbRect(null)).toBeNull()
    expect(sanitizeThumbRect('rect')).toBeNull()
    expect(sanitizeThumbRect({ x: 0, y: 0, width: 100 })).toBeNull()
    expect(sanitizeThumbRect({ x: 0, y: 0, width: NaN, height: 100 })).toBeNull()
    expect(sanitizeThumbRect({ x: 0, y: 0, width: Infinity, height: 100 })).toBeNull()
    expect(sanitizeThumbRect({ x: 0, y: 0, width: 4, height: 100 })).toBeNull()
    expect(sanitizeThumbRect({ x: 0, y: 0, width: 100, height: 0 })).toBeNull()
  })

  it('caps implausible dimensions instead of allocating them', () => {
    const r = sanitizeThumbRect({ x: 0, y: 0, width: 1e9, height: 1e9 })
    expect(r).toEqual({ x: 0, y: 0, width: 8192, height: 8192 })
  })
})

describe('pngDataUrl / buildThumbsMap', () => {
  it('encodes PNG bytes as a data URL', () => {
    expect(pngDataUrl(Buffer.from('png-bytes'))).toBe(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
    )
  })

  it('maps each dir to its <dirHash>.png and omits dirs with no cached thumb', () => {
    const dirs = ['C:\\work\\alpha', 'C:\\work\\beta']
    const files: Record<string, Buffer> = { [`${dirHash(dirs[0])}.png`]: Buffer.from('alpha-png') }
    const map = buildThumbsMap(dirs, (name) => files[name] ?? null)
    expect(Object.keys(map)).toEqual([dirs[0]])
    expect(map[dirs[0]]).toBe(pngDataUrl(Buffer.from('alpha-png')))
  })
})

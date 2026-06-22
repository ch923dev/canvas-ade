import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listLibrary, resolveLibraryItem } from './projectLibrary'

describe('projectLibrary', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-lib-'))
    mkdirSync(join(dir, '.canvas', 'downloads'), { recursive: true })
    mkdirSync(join(dir, '.canvas', 'assets'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('listLibrary', () => {
    it('lists files in downloads + assets, skipping subdirs like .trash', () => {
      writeFileSync(join(dir, '.canvas', 'downloads', 'report.pdf'), 'a')
      writeFileSync(join(dir, '.canvas', 'downloads', 'build.zip'), 'bb')
      mkdirSync(join(dir, '.canvas', 'downloads', '.trash')) // must be skipped (not a file)
      writeFileSync(join(dir, '.canvas', 'assets', 'deadbeef.png'), 'img')

      const lib = listLibrary(dir)
      expect(lib.downloads.map((i) => i.name).sort()).toEqual(['build.zip', 'report.pdf'])
      expect(
        lib.downloads.every((i) => i.relPath.startsWith('downloads/') && i.kind === 'download')
      ).toBe(true)
      expect(lib.assets.map((i) => i.name)).toEqual(['deadbeef.png'])
      expect(lib.assets[0]).toMatchObject({ relPath: 'assets/deadbeef.png', kind: 'asset' })
      expect(lib.downloadsDir).toBe(join(dir, '.canvas', 'downloads'))
    })

    it('returns empty arrays when the .canvas dirs are absent', () => {
      rmSync(join(dir, '.canvas'), { recursive: true, force: true })
      const lib = listLibrary(dir)
      expect(lib.downloads).toEqual([])
      expect(lib.assets).toEqual([])
    })
  })

  describe('resolveLibraryItem (.canvas containment)', () => {
    it('accepts a file directly inside downloads/ or assets/', () => {
      expect(resolveLibraryItem(dir, 'downloads/report.pdf')).toBe(
        join(dir, '.canvas', 'downloads', 'report.pdf')
      )
      expect(resolveLibraryItem(dir, 'assets/x.png')).toBe(join(dir, '.canvas', 'assets', 'x.png'))
    })

    it('rejects traversal, escapes, nested paths, and non-library locations', () => {
      expect(resolveLibraryItem(dir, '../../etc/passwd')).toBeNull()
      expect(resolveLibraryItem(dir, 'downloads/../../secret')).toBeNull()
      expect(resolveLibraryItem(dir, 'downloads/sub/x')).toBeNull() // nested, not a direct child
      expect(resolveLibraryItem(dir, 'canvas.json')).toBeNull() // not under downloads/ or assets/
      expect(resolveLibraryItem(dir, 'memory/MEMORY.md')).toBeNull() // a .canvas sibling, not allowed
      expect(resolveLibraryItem(dir, '')).toBeNull()
    })
  })
})

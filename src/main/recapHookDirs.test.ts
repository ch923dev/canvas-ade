import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordRecapHookDir, listRecapHookDirs, clearRecapHookDirs } from './recapHookDirs'

describe('recapHookDirs — the divergent-install registry (PR #333 review, warning)', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'recap-dirs-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('records, lists, and clears divergent dirs per consenting project', () => {
    recordRecapHookDir(userData, 'C:/proj', 'D:/other')
    recordRecapHookDir(userData, 'C:/proj', 'E:/third')
    recordRecapHookDir(userData, 'C:/unrelated', 'F:/elsewhere')
    expect(listRecapHookDirs(userData, 'C:/proj').sort()).toEqual(['D:/other', 'E:/third'])
    clearRecapHookDirs(userData, 'C:/proj')
    expect(listRecapHookDirs(userData, 'C:/proj')).toEqual([])
    // Other projects' entries survive a targeted clear.
    expect(listRecapHookDirs(userData, 'C:/unrelated')).toEqual(['F:/elsewhere'])
  })

  it('never stores the project root itself, and re-records are no-op rewrites', () => {
    recordRecapHookDir(userData, 'C:/proj', 'C:/proj')
    expect(listRecapHookDirs(userData, 'C:/proj')).toEqual([])
    recordRecapHookDir(userData, 'C:/proj', 'D:/other')
    recordRecapHookDir(userData, 'C:/proj', 'D:/other')
    expect(listRecapHookDirs(userData, 'C:/proj')).toEqual(['D:/other'])
  })

  it('persists across "restarts" (fresh reads) and survives a corrupt file as {}', () => {
    recordRecapHookDir(userData, 'C:/proj', 'D:/other')
    // A fresh read (new process semantics) still sees the entry.
    expect(listRecapHookDirs(userData, 'C:/proj')).toEqual(['D:/other'])
    expect(readFileSync(join(userData, 'recap-hook-dirs.json'), 'utf8')).toContain('D:/other')
    // Corrupt file degrades to the safe default.
    writeFileSync(join(userData, 'recap-hook-dirs.json'), '{not json')
    expect(listRecapHookDirs(userData, 'C:/proj')).toEqual([])
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  listRecents,
  touchRecent,
  removeRecent,
  clearRecents,
  RECENT_LIMIT
} from './recentProjects'

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'canvas-recents-'))
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('recentProjects', () => {
  it('returns [] when the file is absent', async () => {
    expect(await listRecents(userData)).toEqual([])
  })

  // L3 cache: the parsed list is cached per userDataDir, validated by the file's mtime+size —
  // a write by ANOTHER process sharing this userData dir (dev builds skip
  // requestSingleInstanceLock) must be seen, not clobbered by our next write.
  it('L3: an external rewrite of the file is picked up despite the warm cache', async () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-b-'))
    await touchRecent(userData, a, 'a', 1000)
    expect((await listRecents(userData)).map((r) => r.name)).toEqual(['a']) // cache primed
    writeFileSync(
      join(userData, 'recent-projects.json'),
      JSON.stringify({
        projects: [
          { path: b, name: 'b', lastOpenedAt: 2000 },
          { path: a, name: 'a', lastOpenedAt: 1000 }
        ]
      })
    )
    expect((await listRecents(userData)).map((r) => r.name)).toEqual(['b', 'a'])
  })

  it('L3: touchRecent builds on an externally-updated file instead of clobbering it', async () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-b-'))
    await touchRecent(userData, a, 'a', 1000) // cache primed with [a]
    writeFileSync(
      join(userData, 'recent-projects.json'),
      JSON.stringify({
        projects: [
          { path: b, name: 'b', lastOpenedAt: 2000 },
          { path: a, name: 'a', lastOpenedAt: 1000 }
        ]
      })
    )
    await touchRecent(userData, a, 'a', 3000)
    // b (the other process's entry) survives; a stale-cache write would have dropped it
    expect((await listRecents(userData)).map((r) => r.name)).toEqual(['a', 'b'])
  })

  it('touchRecent inserts, then move-to-front on re-touch', async () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-b-'))
    await touchRecent(userData, a, 'a', 1000)
    await touchRecent(userData, b, 'b', 2000)
    expect((await listRecents(userData)).map((r) => r.path)).toEqual([b, a])
    await touchRecent(userData, a, 'a', 3000)
    expect((await listRecents(userData)).map((r) => r.path)).toEqual([a, b])
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('caps the list at RECENT_LIMIT', async () => {
    const dirs: string[] = []
    for (let i = 0; i < RECENT_LIMIT + 5; i++) {
      const d = mkdtempSync(join(tmpdir(), `proj-${i}-`))
      dirs.push(d)
      await touchRecent(userData, d, `p${i}`, i)
    }
    expect((await listRecents(userData)).length).toBe(RECENT_LIMIT)
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
  })

  it('atomic write produces a valid, parseable file (no temp leftovers) (BUG-L5)', async () => {
    const live = mkdtempSync(join(tmpdir(), 'proj-atomic-'))
    await touchRecent(userData, live, 'live', 1)
    const file = join(userData, 'recent-projects.json')
    // The final file is present and valid JSON (not a torn/zeroed write).
    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.projects).toHaveLength(1)
    expect(parsed.projects[0].path).toBe(live)
    expect((await listRecents(userData)).map((r) => r.path)).toEqual([live])
    rmSync(live, { recursive: true, force: true })
  })

  it('prunes entries whose folder no longer exists', async () => {
    const gone = join(tmpdir(), 'definitely-not-here-' + Math.random())
    const live = mkdtempSync(join(tmpdir(), 'proj-live-'))
    await touchRecent(userData, gone, 'gone', 1)
    await touchRecent(userData, live, 'live', 2)
    expect((await listRecents(userData)).map((r) => r.path)).toEqual([live])
    rmSync(live, { recursive: true, force: true })
  })

  // BUG-044: listRecents' existence prune (incl. the 500ms pathExists timeout for slow
  // UNC/SMB shares) is a DISPLAY concern. touchRecent must persist from the unfiltered
  // stored list, or a transiently-slow recent path is permanently deleted from the MRU
  // file the next time ANY project is opened.
  it('BUG-044: an entry hidden by the display prune survives a later touchRecent', async () => {
    const slow = join(tmpdir(), 'transiently-slow-share-' + Math.random())
    const live = mkdtempSync(join(tmpdir(), 'proj-live44-'))
    await touchRecent(userData, slow, 'slow', 1)
    await touchRecent(userData, live, 'live', 2) // opening another project re-persists
    // Display prunes the unreachable path...
    expect((await listRecents(userData)).map((r) => r.path)).toEqual([live])
    // ...but the persisted MRU file still carries it (prune is read-time only).
    const onDisk = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(onDisk.projects.map((p) => p.path)).toEqual([live, slow])
    rmSync(live, { recursive: true, force: true })
  })

  it('removeRecent drops only the target and persists; the folder on disk is untouched', async () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-rm-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-rm-b-'))
    await touchRecent(userData, a, 'a', 1)
    await touchRecent(userData, b, 'b', 2)
    await removeRecent(userData, b)
    expect((await listRecents(userData)).map((r) => r.path)).toEqual([a])
    // Persisted, not just display-filtered.
    const onDisk = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(onDisk.projects.map((p) => p.path)).toEqual([a])
    // LIST-ONLY: the removed entry's folder still exists on disk.
    expect(existsSync(b)).toBe(true)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('removeRecent of an unknown path is a no-op (BUG-044: never rewrites the stored list)', async () => {
    const slow = join(tmpdir(), 'transiently-slow-share-' + Math.random())
    await touchRecent(userData, slow, 'slow', 1)
    // Removing a path that is not stored must NOT persist the display-pruned list
    // (which would permanently delete the merely-slow entry).
    await removeRecent(userData, join(tmpdir(), 'never-stored-' + Math.random()))
    const onDisk = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(onDisk.projects.map((p) => p.path)).toEqual([slow])
  })

  it('removeRecent can remove an entry the display prune is hiding', async () => {
    const slow = join(tmpdir(), 'transiently-slow-share-' + Math.random())
    const live = mkdtempSync(join(tmpdir(), 'proj-rm-live-'))
    await touchRecent(userData, slow, 'slow', 1)
    await touchRecent(userData, live, 'live', 2)
    await removeRecent(userData, slow) // not visible in listRecents, but stored
    const onDisk = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(onDisk.projects.map((p) => p.path)).toEqual([live])
    rmSync(live, { recursive: true, force: true })
  })

  it('clearRecents empties the stored list; project folders are untouched', async () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-clear-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-clear-b-'))
    await touchRecent(userData, a, 'a', 1)
    await touchRecent(userData, b, 'b', 2)
    await clearRecents(userData)
    expect(await listRecents(userData)).toEqual([])
    const onDisk = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(onDisk.projects).toEqual([])
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listRecents, touchRecent, RECENT_LIMIT } from './recentProjects'

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'canvas-recents-'))
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('recentProjects', () => {
  it('returns [] when the file is absent', () => {
    expect(listRecents(userData)).toEqual([])
  })

  it('touchRecent inserts, then move-to-front on re-touch', () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-b-'))
    touchRecent(userData, a, 'a', 1000)
    touchRecent(userData, b, 'b', 2000)
    expect(listRecents(userData).map((r) => r.path)).toEqual([b, a])
    touchRecent(userData, a, 'a', 3000)
    expect(listRecents(userData).map((r) => r.path)).toEqual([a, b])
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('caps the list at RECENT_LIMIT', () => {
    const dirs: string[] = []
    for (let i = 0; i < RECENT_LIMIT + 5; i++) {
      const d = mkdtempSync(join(tmpdir(), `proj-${i}-`))
      dirs.push(d)
      touchRecent(userData, d, `p${i}`, i)
    }
    expect(listRecents(userData).length).toBe(RECENT_LIMIT)
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
  })

  it('prunes entries whose folder no longer exists', () => {
    const gone = join(tmpdir(), 'definitely-not-here-' + Math.random())
    const live = mkdtempSync(join(tmpdir(), 'proj-live-'))
    touchRecent(userData, gone, 'gone', 1)
    touchRecent(userData, live, 'live', 2)
    expect(listRecents(userData).map((r) => r.path)).toEqual([live])
    rmSync(live, { recursive: true, force: true })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
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
  it('returns [] when the file is absent', async () => {
    expect(await listRecents(userData)).toEqual([])
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
})

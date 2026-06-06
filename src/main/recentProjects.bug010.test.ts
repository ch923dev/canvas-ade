/**
 * Regression tests for BUG-010.
 *
 * BUG-010: listRecents calls existsSync(r.path) synchronously for every entry, which can block
 *          for the full SMB timeout (5–30 s) when the path is a UNC/network share that's offline.
 *          Fix: make listRecents async and use fs.promises.access with a per-path timeout so the
 *          IPC thread is never blocked waiting for a dead SMB share.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listRecents } from './recentProjects'

// NOTE: this file tests the REAL recentProjects module (no vi.mock) to verify the async behavior.

describe('BUG-010: listRecents is async — IPC thread never blocks on stale network paths', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'canvas-recents-010-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('BUG-010 red→green: listRecents returns a Promise (is async), not a plain array', async () => {
    // Pre-fix: listRecents returns RecentProject[] (synchronously) — not a Promise.
    // The IPC thread blocks during the filter() call on every entry's existsSync.
    // Post-fix: listRecents returns Promise<RecentProject[]> so the IPC thread yields.
    const result = listRecents(userData)
    expect(result).toBeInstanceOf(Promise)
    // Must resolve to an empty array when no file exists.
    expect(await result).toEqual([])
  })

  it('BUG-010: async listRecents still prunes entries whose folder does not exist', async () => {
    const liveDir = mkdtempSync(join(tmpdir(), 'proj-live-010b-'))
    const recentFile = join(userData, 'recent-projects.json')
    writeFileSync(
      recentFile,
      JSON.stringify({
        projects: [
          { path: liveDir, name: 'live', lastOpenedAt: 2000 },
          {
            path: join(tmpdir(), 'definitely-gone-' + Math.random()),
            name: 'gone',
            lastOpenedAt: 1000
          }
        ]
      })
    )

    const result = await listRecents(userData)
    expect(result.map((r) => r.path)).toEqual([liveDir])

    rmSync(liveDir, { recursive: true, force: true })
  })

  it('BUG-010: async listRecents handles a non-existent UNC-style path in bounded time', async () => {
    // This test verifies that a locally-unresolvable path is pruned quickly.
    // On real offline UNC shares, the old sync existsSync would block for 5–30 s.
    // The async implementation resolves/rejects via access() + AbortSignal timeout.
    const recentFile = join(userData, 'recent-projects.json')
    writeFileSync(
      recentFile,
      JSON.stringify({
        projects: [
          // A UNC-style path that does not exist locally.
          { path: '\\\\dead-server\\share\\proj', name: 'unc', lastOpenedAt: 1000 }
        ]
      })
    )

    const start = Date.now()
    const result = await listRecents(userData)
    const elapsed = Date.now() - start

    // The stale path is pruned.
    expect(result).toEqual([])
    // Must complete in under 2 s (the async timeout per path is ~500 ms max).
    expect(elapsed).toBeLessThan(2000)
  })
})

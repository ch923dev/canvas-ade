import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import {
  classifyStale,
  classifyOwnRun,
  scanTempDirs,
  removeTempDirs,
  STALE_MS
} from './e2eTempSweep'

const now = 1_800_000_000_000
const hours = (n: number) => n * 60 * 60 * 1000

describe('classifyStale (globalSetup retention sweep)', () => {
  it('deletes scratch idle past the window, keeps fresh scratch', () => {
    const d = classifyStale(
      [
        { name: 'playwright-artifacts-dead', newestMtimeMs: now - hours(7) },
        { name: 'playwright-tracing-dead', newestMtimeMs: now - hours(48) },
        { name: 'playwright-artifacts-live', newestMtimeMs: now - 5_000 }
      ],
      now
    )
    expect(d.delete.sort()).toEqual(['playwright-artifacts-dead', 'playwright-tracing-dead'])
    expect(d.keep).toEqual(['playwright-artifacts-live'])
  })

  it('exactly at the boundary counts as stale', () => {
    const d = classifyStale(
      [{ name: 'playwright-artifacts-x', newestMtimeMs: now - STALE_MS }],
      now
    )
    expect(d.delete).toEqual(['playwright-artifacts-x'])
  })

  it('never deletes the shared transform cache, however old', () => {
    const d = classifyStale(
      [{ name: 'playwright-transform-cache', newestMtimeMs: now - hours(24 * 90) }],
      now
    )
    expect(d.delete).toEqual([])
    expect(d.keep).toEqual(['playwright-transform-cache'])
  })

  it('ignores non-playwright names outright', () => {
    const d = classifyStale([{ name: 'chrome-profile-xyz', newestMtimeMs: 0 }], now)
    expect(d.delete).toEqual([])
    expect(d.keep).toEqual(['chrome-profile-xyz'])
  })

  it('honours a custom window', () => {
    const d = classifyStale(
      [{ name: 'playwright-artifacts-x', newestMtimeMs: now - hours(1) }],
      now,
      hours(0.5)
    )
    expect(d.delete).toEqual(['playwright-artifacts-x'])
  })
})

describe('classifyOwnRun (globalTeardown snapshot diff)', () => {
  const preRun = new Set(['playwright-artifacts-old', 'playwright-transform-cache'])

  it('deletes only dirs created since the pre-run snapshot', () => {
    const d = classifyOwnRun(
      [
        { name: 'playwright-artifacts-old', newestMtimeMs: now },
        { name: 'playwright-artifacts-new', newestMtimeMs: now },
        { name: 'playwright-tracing-new', newestMtimeMs: now }
      ],
      preRun
    )
    expect(d.delete.sort()).toEqual(['playwright-artifacts-new', 'playwright-tracing-new'])
    expect(d.keep).toEqual(['playwright-artifacts-old'])
  })

  it('keeps the transform cache even when it appeared mid-run', () => {
    const d = classifyOwnRun(
      [{ name: 'playwright-transform-cache', newestMtimeMs: now }],
      new Set()
    )
    expect(d.delete).toEqual([])
  })

  it('keeps non-playwright names', () => {
    const d = classifyOwnRun([{ name: 'other-tool-tmp', newestMtimeMs: now }], new Set())
    expect(d.delete).toEqual([])
  })
})

describe('scanTempDirs / removeTempDirs (fs walkers)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(os.tmpdir(), 'sweep-test-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('scan lists only playwright* dirs and reports the newest child mtime', () => {
    mkdirSync(join(root, 'playwright-artifacts-a'))
    writeFileSync(join(root, 'playwright-artifacts-a', 'x.trace'), 'x')
    mkdirSync(join(root, 'unrelated-dir'))
    writeFileSync(join(root, 'playwright-loose-file'), 'not a dir')
    const fresh = Date.now() + 60_000
    utimesSync(join(root, 'playwright-artifacts-a', 'x.trace'), fresh / 1000, fresh / 1000)

    const dirs = scanTempDirs(root)
    expect(dirs.map((d) => d.name)).toEqual(['playwright-artifacts-a'])
    expect(dirs[0].newestMtimeMs).toBeGreaterThan(Date.now())
  })

  it('scan of a missing root returns empty, no throw', () => {
    expect(scanTempDirs(join(root, 'does-not-exist'))).toEqual([])
  })

  it('remove deletes named dirs recursively and reports them', () => {
    mkdirSync(join(root, 'playwright-artifacts-a', 'resources'), { recursive: true })
    writeFileSync(join(root, 'playwright-artifacts-a', 'resources', 'r.dat'), 'data')
    const removed = removeTempDirs(root, ['playwright-artifacts-a'])
    expect(removed).toEqual(['playwright-artifacts-a'])
    expect(existsSync(join(root, 'playwright-artifacts-a'))).toBe(false)
  })

  it('remove refuses names outside the playwright* family or containing separators', () => {
    mkdirSync(join(root, 'victim'))
    const removed = removeTempDirs(root, ['victim', '../victim', 'playwright-ok\\..\\victim'])
    expect(removed).toEqual([])
    expect(existsSync(join(root, 'victim'))).toBe(true)
  })
})

/**
 * Unit tests for the persisted divergent-dir store (W1-E · F8). Pure Node fs against a real temp
 * userData dir — no electron, no mocks. Covers the persist+reload round-trip (the core F8 fix),
 * per-project clear isolation, idempotency, the never-store-the-root invariant, and the
 * parse-defensive degrade-to-empty path for a missing / corrupt store file.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  clearPersistedDirs,
  loadProvisionedDirs,
  persistProvisionedDir
} from './provisionedDirStore'

const TEST_HOME = `${(process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp').replace(
  /[\\/]+$/,
  ''
)}/prov-store-${process.pid}-${Date.now()}`

/** A throwaway userData dir under TEST_HOME (mkdtempSync needs an existing parent). */
function freshUserData(): string {
  return mkdtempSync(join(TEST_HOME, 'ud-'))
}

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
  mkdirSync(TEST_HOME, { recursive: true })
})

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }))

describe('provisionedDirStore', () => {
  it('persists + reloads a divergent dir round-trip (F8-persist-reload), idempotent on re-write', () => {
    const ud = freshUserData()
    persistProvisionedDir(ud, '/proj', '/proj/sub')
    persistProvisionedDir(ud, '/proj', '/proj/sub') // duplicate write must not duplicate the entry

    const map = new Map<string, Set<string>>()
    loadProvisionedDirs(ud, map)

    expect([...map.keys()]).toEqual(['/proj'])
    expect([...(map.get('/proj') ?? [])]).toEqual(['/proj/sub'])
  })

  it('tracks multiple divergent dirs under one project', () => {
    const ud = freshUserData()
    persistProvisionedDir(ud, '/proj', '/proj/api')
    persistProvisionedDir(ud, '/proj', '/proj/web')

    const map = new Map<string, Set<string>>()
    loadProvisionedDirs(ud, map)
    expect([...(map.get('/proj') ?? [])].sort()).toEqual(['/proj/api', '/proj/web'])
  })

  it('never stores the project root (only divergent dirs are tracked)', () => {
    const ud = freshUserData()
    persistProvisionedDir(ud, '/proj', '/proj') // root target → no-op, no file written
    expect(existsSync(join(ud, 'provisioned-dirs.json'))).toBe(false)

    const map = new Map<string, Set<string>>()
    loadProvisionedDirs(ud, map)
    expect(map.size).toBe(0)
  })

  it('merges into an existing in-memory Set (idempotent re-load, Set-union)', () => {
    const ud = freshUserData()
    persistProvisionedDir(ud, '/proj', '/proj/sub')

    const map = new Map<string, Set<string>>([['/proj', new Set(['/proj/inmem'])]])
    loadProvisionedDirs(ud, map)
    expect([...(map.get('/proj') ?? [])].sort()).toEqual(['/proj/inmem', '/proj/sub'])
  })

  it('clears only the target project (clearPersistedDirs isolation)', () => {
    const ud = freshUserData()
    persistProvisionedDir(ud, '/projA', '/projA/sub')
    persistProvisionedDir(ud, '/projB', '/projB/sub')

    clearPersistedDirs(ud, '/projA')

    const map = new Map<string, Set<string>>()
    loadProvisionedDirs(ud, map)
    expect([...map.keys()]).toEqual(['/projB'])
    // Clearing an absent project is a no-op (no throw).
    expect(() => clearPersistedDirs(ud, '/never')).not.toThrow()
  })

  it('degrades to empty on a missing file (no throw)', () => {
    const ud = freshUserData()
    const map = new Map<string, Set<string>>()
    expect(() => loadProvisionedDirs(ud, map)).not.toThrow()
    expect(map.size).toBe(0)
  })

  it('degrades to empty on a corrupt store file (no throw)', () => {
    const ud = freshUserData()
    writeFileSync(join(ud, 'provisioned-dirs.json'), '{ this is : not json')

    const map = new Map<string, Set<string>>()
    expect(() => loadProvisionedDirs(ud, map)).not.toThrow()
    expect(map.size).toBe(0)
  })

  it('ignores non-array / non-string entries from a hand-edited file (type-defensive read)', () => {
    const ud = freshUserData()
    writeFileSync(
      join(ud, 'provisioned-dirs.json'),
      JSON.stringify({ '/proj': ['/proj/ok', 42, null], '/bad': 'not-an-array' })
    )

    const map = new Map<string, Set<string>>()
    loadProvisionedDirs(ud, map)
    expect([...map.keys()]).toEqual(['/proj'])
    expect([...(map.get('/proj') ?? [])]).toEqual(['/proj/ok'])
  })

  it('writes a stable, human-readable JSON shape', () => {
    const ud = freshUserData()
    persistProvisionedDir(ud, '/proj', '/proj/sub')
    const raw = JSON.parse(readFileSync(join(ud, 'provisioned-dirs.json'), 'utf8'))
    expect(raw).toEqual({ '/proj': ['/proj/sub'] })
  })
})

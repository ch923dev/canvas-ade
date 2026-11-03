/**
 * "A canvas-format change forces older apps to update" (project-workspaces O-2, §4.9).
 *
 * Two halves:
 *  1. THE GUARD — runs the production rules against the REAL build/updates.json, package.json and
 *     boardSchemaVersion.ts. The PR that raises MIN_READER_VERSION fails here until it records the
 *     new floor in build/updates.json `minSupportedByFloor` AND raises `minSupported` — so a format
 *     change can never ship without forcing older apps off it.
 *  2. The pure decision logic of both release paths (scripts/release-floor.mjs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain ESM build script, no .d.ts (runtime-only helper).
import * as releaseFloor from './release-floor.mjs'

const {
  parseMinReaderVersion,
  readMinReaderVersion,
  planProductionManifest,
  planLocalManifest,
  readPreviousFeedManifest,
  cmpVersion,
  PRE_RULE_FLOOR
} = releaseFloor

const root = fileURLToPath(new URL('..', import.meta.url))
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, rel), 'utf8'))

// ─── 1. The guard (real repo files) ──────────────────────────────────────────

describe('guard: the canvas floor and build/updates.json move together', () => {
  it('reads the floor from boardSchemaVersion.ts (exactly one integer literal)', () => {
    const floor = readMinReaderVersion(root)
    expect(Number.isSafeInteger(floor)).toBe(true)
    expect(floor).toBeGreaterThanOrEqual(23)
  })

  it('build/updates.json records the current floor and its minSupported (O-2)', () => {
    const { errors, manifest } = planProductionManifest({
      source: readJson('build/updates.json'),
      appVersion: readJson('package.json').version,
      floor: readMinReaderVersion(root)
    })
    // On failure the message says exactly what to add to build/updates.json.
    expect(errors).toEqual([])
    expect(manifest.minReaderVersion).toBe(readMinReaderVersion(root))
  })
})

// ─── 2a. Reading the floor ───────────────────────────────────────────────────

describe('parseMinReaderVersion', () => {
  it('parses the export line (with or without a type annotation / semicolon)', () => {
    expect(parseMinReaderVersion('/** doc */\nexport const MIN_READER_VERSION = 23\n')).toBe(23)
    expect(parseMinReaderVersion('export const MIN_READER_VERSION: number = 24;')).toBe(24)
  })

  it('ignores mentions in comments', () => {
    const src =
      ' * MIN_READER_VERSION stays 21\n * (see MIN_READER_VERSION below)\nexport const MIN_READER_VERSION = 23'
    expect(parseMinReaderVersion(src)).toBe(23)
  })

  it('throws (never silently skips the force) when the literal is missing, hidden or doubled', () => {
    expect(() => parseMinReaderVersion('export const SCHEMA_VERSION = 23')).toThrow(/found 0/)
    expect(() => parseMinReaderVersion('export const MIN_READER_VERSION = BASE + 1')).toThrow()
    expect(() =>
      parseMinReaderVersion(
        'export const MIN_READER_VERSION = 23\nexport const MIN_READER_VERSION = 24'
      )
    ).toThrow(/found 2/)
    expect(() => parseMinReaderVersion('export const MIN_READER_VERSION = 0')).toThrow(/positive/)
  })
})

describe('cmpVersion mirrors the app (src/main/autoUpdate.ts): pre-release ignored', () => {
  it('orders numerically and ignores -local.N', () => {
    expect(cmpVersion('0.47.27', '0.48.0')).toBe(-1)
    expect(cmpVersion('0.48.0', '0.47.27')).toBe(1)
    expect(cmpVersion('0.48.1-local.1', '0.48.1-local.7')).toBe(0)
    expect(cmpVersion('0.47.28-local.3', '0.48.1-local.1')).toBe(-1)
  })
})

// ─── 2b. Production (build/updates.json → feed updates.json) ─────────────────

describe('planProductionManifest', () => {
  const base = {
    minSupported: '0.9.0',
    minSupportedByFloor: { '23': '0.9.0' },
    tiers: {}
  }

  it('floor unchanged ⇒ minSupported untouched, minReaderVersion recorded', () => {
    const { errors, manifest } = planProductionManifest({
      source: base,
      appVersion: '0.47.27',
      floor: 23
    })
    expect(errors).toEqual([])
    expect(manifest).toEqual({
      latest: '0.47.27',
      minSupported: '0.9.0',
      minReaderVersion: 23,
      tiers: {}
    })
  })

  it('floor up without a record ⇒ refused, naming the exact fix', () => {
    const { errors, manifest } = planProductionManifest({
      source: base,
      appVersion: '0.48.0',
      floor: 24
    })
    expect(manifest).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(
      /floor rose: MIN_READER_VERSION is 24 but build\/updates.json records 23/
    )
    expect(errors[0]).toContain('"24": "0.48.0"')
    expect(errors[0]).toContain('"minSupported": "0.48.0"')
  })

  it('floor up, recorded but minSupported NOT raised in the same change ⇒ refused', () => {
    const { errors } = planProductionManifest({
      source: { ...base, minSupportedByFloor: { '23': '0.9.0', '24': '0.48.0' } },
      appVersion: '0.48.0',
      floor: 24
    })
    expect(errors).toEqual([
      expect.stringMatching(/minSupported is 0.9.0 but canvas floor 24 requires at least 0.48.0/)
    ])
  })

  it('floor up, recorded with minSupported = this version ⇒ published force', () => {
    const { errors, manifest } = planProductionManifest({
      source: {
        minSupported: '0.48.0',
        minSupportedByFloor: { '23': '0.9.0', '24': '0.48.0' },
        tiers: {}
      },
      appVersion: '0.48.0',
      floor: 24
    })
    expect(errors).toEqual([])
    expect(manifest.minSupported).toBe('0.48.0')
    expect(manifest.minReaderVersion).toBe(24)
  })

  it('later ordinary releases keep the force (minSupported is sticky in the source)', () => {
    const { errors, manifest } = planProductionManifest({
      source: {
        minSupported: '0.48.0',
        minSupportedByFloor: { '23': '0.9.0', '24': '0.48.0' },
        tiers: { '0.48.3': 'recommended' }
      },
      appVersion: '0.48.3',
      floor: 24
    })
    expect(errors).toEqual([])
    expect(manifest).toEqual({
      latest: '0.48.3',
      minSupported: '0.48.0',
      minReaderVersion: 24,
      tiers: { '0.48.3': 'recommended' }
    })
  })

  it('a copy-pasted (non-rising) floor entry is refused', () => {
    const { errors } = planProductionManifest({
      source: {
        minSupported: '0.48.0',
        minSupportedByFloor: { '23': '0.9.0', '24': '0.48.0', '25': '0.48.0' },
        tiers: {}
      },
      appVersion: '0.50.0',
      floor: 25
    })
    expect(errors.join('\n')).toMatch(/minSupportedByFloor\["25"\] = 0.48.0 must be ABOVE/)
  })

  it('a floor entry or minSupported ahead of the release is refused (self-forcing loop)', () => {
    const { errors } = planProductionManifest({
      source: {
        minSupported: '0.49.0',
        minSupportedByFloor: { '23': '0.9.0', '24': '0.49.0' },
        tiers: {}
      },
      appVersion: '0.48.0',
      floor: 24
    })
    expect(errors.join('\n')).toMatch(/ahead of this release/)
    expect(errors.join('\n')).toMatch(/above this release/)
  })

  it('a floor BELOW the record is refused (floors never go down)', () => {
    const { errors } = planProductionManifest({
      source: { minSupported: '0.48.0', minSupportedByFloor: { '23': '0.9.0', '24': '0.48.0' } },
      appVersion: '0.48.1',
      floor: 23
    })
    expect(errors.join('\n')).toMatch(/Floors never go down/)
  })

  it('a missing record is refused', () => {
    const { errors } = planProductionManifest({
      source: { minSupported: '0.9.0', tiers: {} },
      appVersion: '0.47.27',
      floor: 23
    })
    expect(errors.join('\n')).toMatch(/no "minSupportedByFloor" object/)
  })

  it('keeps the existing semver + tier validation', () => {
    const { errors } = planProductionManifest({
      source: { ...base, minSupported: '0.9', tiers: { 'x.y': 'loud' } },
      appVersion: '0.47.27',
      floor: 23
    })
    const all = errors.join('\n')
    expect(all).toMatch(/minSupported is not semver: 0.9/)
    expect(all).toMatch(/tiers key is not semver: x.y/)
    expect(all).toMatch(/must be "recommended" or "optional", got "loud"/)
  })
})

// ─── 2c. Local (previous <feed>/updates.json → new one) ──────────────────────

describe('planLocalManifest', () => {
  const ok = (data: unknown): { status: 'ok'; data: unknown } => ({ status: 'ok', data })

  it('an ordinary local release never forces (floor unchanged, no earlier force)', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.47.28-local.1', minReaderVersion: 23, tiers: {} }),
      stamped: '0.47.28-local.2',
      floor: 23
    })
    expect(r.forced).toBe(false)
    expect(r.carried).toBe(false)
    expect(r.warnings).toEqual([])
    expect(r.manifest).toEqual({ latest: '0.47.28-local.2', minReaderVersion: 23, tiers: {} })
    expect(r.manifest).not.toHaveProperty('minSupported')
  })

  it('floor up ⇒ minSupported = this stamp (every older install is forced)', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.47.28-local.3', minReaderVersion: 23, tiers: {} }),
      stamped: '0.48.1-local.1',
      floor: 24
    })
    expect(r.forced).toBe(true)
    expect(r.previousFloor).toBe(23)
    expect(r.warnings).toEqual([])
    expect(r.manifest).toEqual({
      latest: '0.48.1-local.1',
      minSupported: '0.48.1-local.1',
      minReaderVersion: 24,
      tiers: {}
    })
  })

  it('floor up within the same X.Y.Z base ⇒ still records the force, but warns it cannot reach that install', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.48.1-local.1', minReaderVersion: 23, tiers: {} }),
      stamped: '0.48.1-local.2',
      floor: 24
    })
    expect(r.forced).toBe(true)
    expect(r.manifest.minSupported).toBe('0.48.1-local.2')
    expect(r.warnings).toEqual([expect.stringMatching(/0.48.1-local.1 will NOT be forced/)])
  })

  it('an ordinary release AFTER a floor raise keeps that force (adds none of its own)', () => {
    const r = planLocalManifest({
      previous: ok({
        latest: '0.48.1-local.1',
        minSupported: '0.48.1-local.1',
        minReaderVersion: 24,
        tiers: {}
      }),
      stamped: '0.48.1-local.2',
      floor: 24
    })
    expect(r.forced).toBe(false)
    expect(r.carried).toBe(true)
    // The carried floor is the RAISE's version, not this one — an install on 0.48.1-local.1 is
    // not forced (the app ignores the -local suffix), only one still below the raise.
    expect(r.manifest.minSupported).toBe('0.48.1-local.1')
  })

  it('missing previous file ⇒ floor treated as unchanged (no force) + a warning', () => {
    const r = planLocalManifest({
      previous: { status: 'missing' },
      stamped: '0.48.1-local.1',
      floor: 24
    })
    expect(r.forced).toBe(false)
    expect(r.manifest).toEqual({ latest: '0.48.1-local.1', minReaderVersion: 24, tiers: {} })
    expect(r.warnings).toEqual([expect.stringMatching(/no previous feed updates.json/)])
  })

  it('unreadable previous file ⇒ unchanged + a warning carrying the reason', () => {
    const r = planLocalManifest({
      previous: { status: 'unreadable', reason: 'x is not valid JSON' },
      stamped: '0.48.1-local.1',
      floor: 24
    })
    expect(r.forced).toBe(false)
    expect(r.manifest).not.toHaveProperty('minSupported')
    expect(r.warnings).toEqual([expect.stringMatching(/unreadable \(x is not valid JSON\)/)])
  })

  it('a pre-rule previous file (no minReaderVersion) counts as floor 23: same floor ⇒ no force', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.47.27-local.4', tiers: {} }),
      stamped: '0.47.28-local.1',
      floor: 23
    })
    expect(r.forced).toBe(false)
    expect(r.previousFloor).toBe(PRE_RULE_FLOOR)
    expect(r.warnings).toEqual([])
    expect(r.manifest).toEqual({ latest: '0.47.28-local.1', minReaderVersion: 23, tiers: {} })
  })

  it('a pre-rule previous file + floor 24 ⇒ forced (no local release needed in between)', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.47.27-local.1', tiers: {} }),
      stamped: '0.48.1-local.1',
      floor: 24
    })
    expect(r.forced).toBe(true)
    expect(r.manifest.minSupported).toBe('0.48.1-local.1')
  })

  it('a malformed previous minReaderVersion ⇒ unchanged + a warning', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.48.1-local.1', minReaderVersion: '23', tiers: {} }),
      stamped: '0.48.2-local.1',
      floor: 24
    })
    expect(r.forced).toBe(false)
    expect(r.manifest).not.toHaveProperty('minSupported')
    expect(r.warnings).toEqual([expect.stringMatching(/malformed canvas floor/)])
  })

  it('drops a malformed or future previous minSupported instead of carrying it', () => {
    const r = planLocalManifest({
      previous: ok({ latest: '0.48.1-local.1', minSupported: '0.99.0', minReaderVersion: 24 }),
      stamped: '0.48.1-local.2',
      floor: 24
    })
    expect(r.manifest).not.toHaveProperty('minSupported')
    expect(r.warnings).toEqual([
      expect.stringMatching(/dropping the previous feed's minSupported "0.99.0"/)
    ])
  })
})

describe('readPreviousFeedManifest', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'release-floor-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('missing / bad JSON / non-object / ok', () => {
    expect(readPreviousFeedManifest(dir)).toEqual({ status: 'missing' })

    writeFileSync(join(dir, 'updates.json'), '{ not json')
    expect(readPreviousFeedManifest(dir)).toMatchObject({ status: 'unreadable' })

    writeFileSync(join(dir, 'updates.json'), '[1, 2]')
    expect(readPreviousFeedManifest(dir)).toMatchObject({ status: 'unreadable' })

    writeFileSync(join(dir, 'updates.json'), '{"latest":"0.47.28-local.1","minReaderVersion":23}')
    expect(readPreviousFeedManifest(dir)).toEqual({
      status: 'ok',
      data: { latest: '0.47.28-local.1', minReaderVersion: 23 }
    })
  })
})

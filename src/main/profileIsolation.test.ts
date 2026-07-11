import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  devProfileSlug,
  resolveDevProfile,
  migrateLegacyProfile,
  applyDevProfileIsolation,
  MIGRATED_FILES,
  type AppPathsLike
} from './profileIsolation'

const CWD = join('M:', 'repo', 'expanse-desktop')

function baseInput(overrides: Partial<Parameters<typeof resolveDevProfile>[0]> = {}) {
  return {
    isPackaged: false,
    env: {} as NodeJS.ProcessEnv,
    cwd: CWD,
    baseUserData: join('C:', 'appdata', 'canvas-ade'),
    ...overrides
  }
}

describe('devProfileSlug', () => {
  it('uses the sanitized checkout folder name plus a 6-hex path hash', () => {
    const slug = devProfileSlug(CWD)
    expect(slug).toMatch(/^expanse-desktop-[0-9a-f]{6}$/)
  })

  it('is stable for the same path and distinct for same-named checkouts elsewhere', () => {
    expect(devProfileSlug(CWD)).toBe(devProfileSlug(CWD))
    const other = devProfileSlug(join('D:', 'elsewhere', 'expanse-desktop'))
    expect(other).not.toBe(devProfileSlug(CWD))
    expect(other.startsWith('expanse-desktop-')).toBe(true)
  })

  it('sanitizes spaces/exotic chars and never yields an empty name', () => {
    expect(devProfileSlug(join('C:', 'My Repos', 'Canvas ADE!'))).toMatch(
      /^canvas-ade-[0-9a-f]{6}$/
    )
    expect(devProfileSlug(sep)).toMatch(/^checkout-[0-9a-f]{6}$/)
  })
})

describe('resolveDevProfile', () => {
  it('leaves packaged builds untouched', () => {
    expect(resolveDevProfile(baseInput({ isPackaged: true }))).toEqual({
      dir: null,
      slug: null,
      fresh: false
    })
  })

  it('leaves the voice spike untouched (voiceBoot owns its own redirect)', () => {
    const out = resolveDevProfile(baseInput({ env: { CANVAS_VOICE_SPIKE: '1' } }))
    expect(out.dir).toBeNull()
  })

  it('defaults to a per-checkout profile under <base>/profiles/<slug>', () => {
    const out = resolveDevProfile(baseInput())
    expect(out.dir).toBe(join('C:', 'appdata', 'canvas-ade', 'profiles', devProfileSlug(CWD)))
    expect(out.fresh).toBe(false)
    expect(out.slug).toBe(devProfileSlug(CWD))
  })

  it('suffixes the e2e harness profile with -e2e and the smoke harness with -smoke', () => {
    const e2e = resolveDevProfile(baseInput({ env: { CANVAS_E2E: '1' } }))
    expect(e2e.dir?.endsWith(`${devProfileSlug(CWD)}-e2e`)).toBe(true)
    const smoke = resolveDevProfile(baseInput({ env: { CANVAS_SMOKE: 'exit' } }))
    expect(smoke.dir?.endsWith(`${devProfileSlug(CWD)}-smoke`)).toBe(true)
  })

  it('CANVAS_USERDATA overrides everything else (resolved absolute)', () => {
    const out = resolveDevProfile(
      baseInput({ env: { CANVAS_USERDATA: join('X:', 'custom'), CANVAS_E2E: '1' } })
    )
    expect(out.dir).toBe(resolve(join('X:', 'custom')))
    expect(out.fresh).toBe(false)
  })

  it('CANVAS_FRESH mints a throwaway dir via the mkdtemp seam', () => {
    const out = resolveDevProfile(
      baseInput({
        env: { CANVAS_FRESH: '1' },
        mkdtemp: (prefix) => `${prefix}abc123`
      })
    )
    expect(out.fresh).toBe(true)
    expect(out.dir).toBe(join(tmpdir(), 'expanse-fresh-') + 'abc123')
  })
})

describe('migrateLegacyProfile', () => {
  let legacy: string
  let profile: string
  beforeEach(() => {
    legacy = mkdtempSync(join(tmpdir(), 'profmig-legacy-'))
    profile = join(mkdtempSync(join(tmpdir(), 'profmig-root-')), 'profiles', 'slug-abcdef')
  })
  afterEach(() => {
    rmSync(legacy, { recursive: true, force: true })
    rmSync(join(profile, '..', '..'), { recursive: true, force: true })
  })

  it('copies present config files + the recap dir into a brand-new profile', () => {
    writeFileSync(join(legacy, 'recent-projects.json'), '{"v":1}', 'utf8')
    writeFileSync(join(legacy, 'hotkey-config.json'), '{"enabled":true}', 'utf8')
    mkdirSync(join(legacy, 'recap'), { recursive: true })
    writeFileSync(join(legacy, 'recap', 'session-map.jsonl'), '{"boardId":"b1"}\n', 'utf8')

    const copied = migrateLegacyProfile(legacy, profile)

    expect(copied).toContain('recent-projects.json')
    expect(copied).toContain('hotkey-config.json')
    expect(copied).toContain('recap/')
    expect(readFileSync(join(profile, 'recent-projects.json'), 'utf8')).toBe('{"v":1}')
    expect(readFileSync(join(profile, 'recap', 'session-map.jsonl'), 'utf8')).toBe(
      '{"boardId":"b1"}\n'
    )
  })

  it('skips absent sources and never invents files', () => {
    const copied = migrateLegacyProfile(legacy, profile)
    expect(copied).toEqual([])
    for (const f of MIGRATED_FILES) expect(existsSync(join(profile, f))).toBe(false)
  })

  it('is a no-op when the profile dir already exists (one-time only)', () => {
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(legacy, 'recent-projects.json'), '{"v":2}', 'utf8')
    expect(migrateLegacyProfile(legacy, profile)).toEqual([])
    expect(existsSync(join(profile, 'recent-projects.json'))).toBe(false)
  })

  it('never migrates the Chromium lockfile or the audit log', () => {
    writeFileSync(join(legacy, 'lockfile'), '', 'utf8')
    writeFileSync(join(legacy, 'mcp-audit.jsonl'), '{"t":1}\n', 'utf8')
    migrateLegacyProfile(legacy, profile)
    expect(existsSync(join(profile, 'lockfile'))).toBe(false)
    expect(existsSync(join(profile, 'mcp-audit.jsonl'))).toBe(false)
  })
})

describe('applyDevProfileIsolation', () => {
  let legacy: string
  beforeEach(() => {
    legacy = mkdtempSync(join(tmpdir(), 'profapply-'))
  })
  afterEach(() => {
    rmSync(legacy, { recursive: true, force: true })
  })

  function fakeApp(isPackaged: boolean): AppPathsLike & { paths: Record<string, string> } {
    const paths: Record<string, string> = {}
    return {
      isPackaged,
      paths,
      getPath: () => legacy,
      setPath: (name, value) => {
        paths[name] = value
      }
    }
  }

  it('redirects BOTH userData and sessionData to the per-checkout profile and migrates', () => {
    writeFileSync(join(legacy, 'recent-projects.json'), '{"v":1}', 'utf8')
    const app = fakeApp(false)
    const out = applyDevProfileIsolation(app, {}, CWD)
    expect(out.dir).toBe(join(legacy, 'profiles', devProfileSlug(CWD)))
    expect(app.paths.userData).toBe(out.dir)
    expect(app.paths.sessionData).toBe(out.dir)
    expect(readFileSync(join(out.dir!, 'recent-projects.json'), 'utf8')).toBe('{"v":1}')
  })

  it('does nothing for a packaged app', () => {
    const app = fakeApp(true)
    const out = applyDevProfileIsolation(app, {}, CWD)
    expect(out.dir).toBeNull()
    expect(app.paths).toEqual({})
  })

  it('CANVAS_FRESH creates the throwaway dir without migrating legacy state', () => {
    writeFileSync(join(legacy, 'recent-projects.json'), '{"v":1}', 'utf8')
    const app = fakeApp(false)
    const out = applyDevProfileIsolation(app, { CANVAS_FRESH: '1' }, CWD)
    try {
      expect(out.fresh).toBe(true)
      expect(out.dir).not.toBeNull()
      expect(existsSync(out.dir!)).toBe(true)
      expect(existsSync(join(out.dir!, 'recent-projects.json'))).toBe(false)
      expect(app.paths.userData).toBe(out.dir)
    } finally {
      if (out.dir) rmSync(out.dir, { recursive: true, force: true })
    }
  })
})

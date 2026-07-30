import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  applyDevCheckContainment,
  provisionDevSandbox,
  resolveDevSandbox,
  SANDBOX_ROOT,
  type AppContainmentLike
} from './devProjectSandbox'
import { devProfileSlug } from './profileIsolation'
import { setSchemaFloorGuard, writeProject } from './projectStore'

const BASE = 'C:\\base-userdata'
const CWD = 'M:\\repo\\.worktrees\\my-feature'

const resolveWith = (
  env: NodeJS.ProcessEnv,
  isPackaged = false
): ReturnType<typeof resolveDevSandbox> =>
  resolveDevSandbox({ isPackaged, env, cwd: CWD, baseUserData: BASE })

describe('resolveDevSandbox', () => {
  it('puts the sandbox under <baseUserData>/devcheck-projects/<slug> (beside profiles/)', () => {
    const d = resolveWith({})
    expect(d.slug).toBe(devProfileSlug(CWD))
    expect(d.dir).toBe(join(BASE, SANDBOX_ROOT, devProfileSlug(CWD)))
  })

  it('is per-checkout — two worktrees never share a sandbox', () => {
    const a = resolveDevSandbox({ isPackaged: false, env: {}, cwd: CWD, baseUserData: BASE })
    const b = resolveDevSandbox({
      isPackaged: false,
      env: {},
      cwd: 'M:\\repo\\.worktrees\\other',
      baseUserData: BASE
    })
    expect(a.dir).not.toBe(b.dir)
  })

  it('is skipped for packaged builds — they open real projects; that is the product', () => {
    expect(resolveWith({}, true)).toEqual({ dir: null, slug: null })
  })

  // These harnesses drive project opens explicitly from their specs / own their own redirect;
  // provisioning a sandbox + rewriting their recents would fight them.
  it.each(['CANVAS_E2E', 'CANVAS_SMOKE', 'CANVAS_VOICE_SPIKE'])('is skipped under %s', (key) => {
    expect(resolveWith({ [key]: '1' }).dir).toBeNull()
  })

  it('still applies under CANVAS_FRESH — a throwaway profile has no recents at all', () => {
    expect(resolveWith({ CANVAS_FRESH: '1' }).dir).toBe(
      join(BASE, SANDBOX_ROOT, devProfileSlug(CWD))
    )
  })

  it('CANVAS_DEV_PROJECT overrides the location (resolved to an absolute path)', () => {
    expect(resolveWith({ CANVAS_DEV_PROJECT: 'C:\\scratch\\proj' }).dir).toBe(
      resolve('C:\\scratch\\proj')
    )
  })
})

describe('applyDevCheckContainment', () => {
  afterEach(() => setSchemaFloorGuard(false))

  const fakeApp = (isPackaged: boolean): AppContainmentLike => ({
    isPackaged,
    getPath: () => BASE
  })

  /** Probe the guard's live state through its only observable: a real floor-raising write. */
  async function floorRaiseBlocked(): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), 'arm-probe-'))
    try {
      await writeProject(dir, { schemaVersion: 22, minReaderVersion: 21, boards: [] })
      await writeProject(dir, { schemaVersion: 23, minReaderVersion: 23, boards: [] })
      return false
    } catch {
      return true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('arms the floor guard for an unpackaged build', async () => {
    applyDevCheckContainment(fakeApp(false), {}, CWD)
    expect(await floorRaiseBlocked()).toBe(true)
  })

  it('leaves the guard OFF for a packaged build — released schema may raise the floor', async () => {
    applyDevCheckContainment(fakeApp(true), {}, CWD)
    expect(await floorRaiseBlocked()).toBe(false)
  })

  it('CANVAS_ALLOW_SCHEMA_RAISE=1 lifts the guard on an unpackaged build', async () => {
    applyDevCheckContainment(fakeApp(false), { CANVAS_ALLOW_SCHEMA_RAISE: '1' }, CWD)
    expect(await floorRaiseBlocked()).toBe(false)
  })

  it('returns the same decision resolveDevSandbox would', () => {
    expect(applyDevCheckContainment(fakeApp(false), {}, CWD)).toEqual(resolveWith({}))
  })
})

describe('provisionDevSandbox', () => {
  let base: string
  let userData: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'sandbox-base-'))
    userData = mkdtempSync(join(tmpdir(), 'sandbox-ud-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  const decisionFor = (dir: string): { dir: string; slug: string } => ({ dir, slug: 'slug-abcdef' })

  it('creates an empty project and fronts it in the recents', async () => {
    const dir = join(base, SANDBOX_ROOT, 'slug-abcdef')
    expect(await provisionDevSandbox(decisionFor(dir), userData, 1000)).toBe(dir)

    const doc = JSON.parse(readFileSync(join(dir, '.canvas', 'canvas.json'), 'utf8'))
    expect(doc.boards).toEqual([])
    const recents = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8'))
    expect(recents.projects[0]).toMatchObject({ path: dir, lastOpenedAt: 1000 })
  })

  it('is idempotent — a re-boot never clobbers boards left in the sandbox', async () => {
    const dir = join(base, SANDBOX_ROOT, 'slug-abcdef')
    await provisionDevSandbox(decisionFor(dir), userData, 1000)
    // Simulate a dev check that left work behind.
    const file = join(dir, '.canvas', 'canvas.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify({ ...doc, boards: [{ id: 'kept' }] }), 'utf8')

    await provisionDevSandbox(decisionFor(dir), userData, 2000)
    expect(JSON.parse(readFileSync(file, 'utf8')).boards).toEqual([{ id: 'kept' }])
  })

  it('keeps the user\u2019s other recents — the floor guard is what makes them harmless', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'recent-projects.json'),
      JSON.stringify({ projects: [{ path: 'M:\\real', name: 'real', lastOpenedAt: 1 }] }),
      'utf8'
    )
    const dir = join(base, SANDBOX_ROOT, 'slug-abcdef')
    await provisionDevSandbox(decisionFor(dir), userData, 2000)

    const recents = JSON.parse(readFileSync(join(userData, 'recent-projects.json'), 'utf8'))
    expect(recents.projects.map((p: { path: string }) => p.path)).toEqual([dir, 'M:\\real'])
  })

  it('no-ops on a null decision (packaged / e2e / smoke)', async () => {
    expect(await provisionDevSandbox({ dir: null, slug: null }, userData, 1000)).toBeNull()
    expect(existsSync(join(userData, 'recent-projects.json'))).toBe(false)
  })
})

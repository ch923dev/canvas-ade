/**
 * WS-3 — the workspace spawn cwd (`strictCwd` / `resolveSpawnCwd`, design §4.2). Real temp dirs, so
 * the realpath layer is exercised for real: a missing root, a root that is a file, a `..` cwd and a
 * symlink/junction escape (of the root AND of the cwd) are all refused with a sentence — never the
 * home-dir fallback a project-level board keeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveSpawnCwd, safeCwd, strictCwd, type StrictCwdWorkspace } from './ptyShells'
import type { WorkspaceMirror } from './workspaceMirror'

let base: string
let project: string
let outside: string

const ws = (over: Partial<StrictCwdWorkspace> = {}): StrictCwdWorkspace => ({
  id: 'ws-api',
  name: 'API',
  root: 'api',
  ...over
})

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws3-strictcwd-'))
  project = path.join(base, 'my project') // spaced, like the real repo path
  outside = path.join(base, 'outside')
  for (const d of ['api/src', 'uploader', '.canvas/worktrees/ws-a/packages/api']) {
    fs.mkdirSync(path.join(project, d), { recursive: true })
  }
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(project, 'notadir'), 'x')
  // 'junction' needs no privilege on Windows; it is ignored (plain dir symlink) elsewhere.
  fs.symlinkSync(outside, path.join(project, 'api', 'escape'), 'junction')
  fs.symlinkSync(outside, path.join(project, 'linked'), 'junction')
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('strictCwd — accepted', () => {
  it('blank cwd starts in the workspace root, with the env facts', () => {
    const r = strictCwd(project, ws(), undefined)
    expect(r).toEqual({
      ok: true,
      cwd: path.join(project, 'api'),
      workspace: {
        id: 'ws-api',
        root: path.join(project, 'api'),
        context: path.join(project, '.canvas', 'workspaces', 'ws-api', 'CONTEXT.md')
      }
    })
  })

  it('an absolute or relative cwd inside the root is kept as given (lexical, not realpath)', () => {
    const abs = path.join(project, 'api', 'src')
    expect(strictCwd(project, ws(), abs)).toMatchObject({ ok: true, cwd: abs })
    expect(strictCwd(project, ws(), 'src')).toMatchObject({ ok: true, cwd: abs })
    expect(strictCwd(project, ws(), '  ')).toMatchObject({
      ok: true,
      cwd: path.join(project, 'api')
    })
  })

  it('a worktree-backed workspace starts in its effective root', () => {
    const w = ws({
      root: 'packages/api',
      worktrees: [{ repoRoot: '.', worktree: '.canvas/worktrees/ws-a' }]
    })
    const want = path.join(project, '.canvas', 'worktrees', 'ws-a', 'packages', 'api')
    expect(strictCwd(project, w, undefined)).toMatchObject({ ok: true, cwd: want })
  })

  it('omits the CONTEXT path for an id that is not a plain file-name segment', () => {
    const r = strictCwd(project, ws({ id: '../x' }), undefined)
    expect(r.ok && r.workspace.context).toBeUndefined()
    expect(r.ok && r.workspace.id).toBe('../x')
  })
})

describe('strictCwd — refused with a sentence, never $HOME', () => {
  const refused = (r: ReturnType<typeof strictCwd>): string => {
    expect(r.ok).toBe(false)
    return r.ok ? '' : r.error
  }

  it('unknown workspace', () => {
    expect(refused(strictCwd(project, undefined, undefined))).toMatch(/workspace no longer exists/)
  })

  it('no project open', () => {
    expect(refused(strictCwd(null, ws(), undefined))).toMatch(/No project is open/)
  })

  it('missing root names the workspace and its folder', () => {
    expect(refused(strictCwd(project, ws({ root: 'gone' }), undefined))).toBe(
      'Workspace "API" folder is missing (gone/). Restore it or remove the workspace.'
    )
  })

  it('root that is a file', () => {
    expect(refused(strictCwd(project, ws({ root: 'notadir' }), undefined))).toMatch(
      /is a file, not a folder/
    )
  })

  it('root that is a junction/symlink out of the project', () => {
    expect(refused(strictCwd(project, ws({ root: 'linked' }), undefined))).toMatch(
      /links outside the project/
    )
  })

  it('a lexically invalid record (root outside the worktree repo)', () => {
    const w = ws({ root: 'uploader', worktrees: [{ repoRoot: 'api', worktree: 'api' }] })
    expect(refused(strictCwd(project, w, undefined))).toMatch(/invalid folder setting/)
  })

  it('`..` cwd into a sibling workspace', () => {
    expect(refused(strictCwd(project, ws(), '../uploader'))).toMatch(/is outside Workspace "API"/)
  })

  it('absolute cwd outside the root (a forged/stale renderer proposal)', () => {
    expect(refused(strictCwd(project, ws(), path.join(project, 'uploader')))).toMatch(
      /is outside Workspace "API"/
    )
    expect(refused(strictCwd(project, ws(), os.homedir()))).toMatch(/is outside|is missing/)
  })

  it('cwd through a junction/symlink that leaves the root', () => {
    expect(refused(strictCwd(project, ws(), 'escape'))).toMatch(/is outside Workspace "API"/)
  })

  it('missing cwd and file cwd', () => {
    expect(refused(strictCwd(project, ws(), 'nope'))).toMatch(/is missing\. Pick a folder inside/)
    const w = ws({ root: '.' })
    expect(refused(strictCwd(project, w, 'notadir'))).toMatch(/is a file, not a folder/)
  })
})

describe('resolveSpawnCwd — MAIN decides from its own mirror', () => {
  const API: WorkspaceMirror = { id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'api' }
  const mirror: WorkspaceMirror[] = [API]
  const deps = { projectDir: () => project, workspaces: () => mirror, settleMs: 0 }

  it('a project-level board keeps safeCwd exactly (incl. the home fallback)', async () => {
    const missing = path.join(project, 'gone')
    expect(await resolveSpawnCwd({ cwd: missing }, deps)).toEqual({ cwd: safeCwd(missing) })
    expect(await resolveSpawnCwd({ cwd: missing, workspaceId: null }, deps)).toEqual({
      cwd: os.homedir()
    })
  })

  it('a workspace board resolves the mirror root and exports its facts', async () => {
    const r = await resolveSpawnCwd({ workspaceId: 'ws-api' }, deps)
    expect(r.error).toBeUndefined()
    expect(r.cwd).toBe(path.join(project, 'api'))
    expect(r.workspace?.root).toBe(path.join(project, 'api'))
  })

  it('refuses a cwd the renderer resolved against a forged root', async () => {
    // The renderer believed the workspace lived in uploader/ — MAIN's mirror says api/.
    const cwd = path.join(project, 'uploader')
    const r = await resolveSpawnCwd({ workspaceId: 'ws-api', cwd }, deps)
    expect(r.error).toMatch(/is outside Workspace "API"/)
    expect(r.workspace).toBeUndefined()
  })

  it('refuses an unknown or malformed workspace id (never read as project-level)', async () => {
    for (const workspaceId of ['nope', '', 42, { id: 'ws-api' }]) {
      const r = await resolveSpawnCwd({ workspaceId }, deps)
      expect(r.error).toMatch(/workspace no longer exists/)
    }
  })

  it('waits briefly for a mirror that has not caught up yet (same-gesture create)', async () => {
    let live: WorkspaceMirror[] = []
    setTimeout(() => (live = [API]), 120) // the renderer's ~150ms publish debounce
    const r = await resolveSpawnCwd(
      { workspaceId: 'ws-api' },
      { projectDir: () => project, workspaces: () => live, settleMs: 1000 }
    )
    expect(r.error).toBeUndefined()
    expect(r.cwd).toBe(path.join(project, 'api'))
  })

  it('a malformed id never waits; an unknown one gives up after the settle window', async () => {
    const t0 = Date.now()
    await resolveSpawnCwd({ workspaceId: 42 }, { ...deps, settleMs: 5000 })
    expect(Date.now() - t0).toBeLessThan(500)
    const t1 = Date.now()
    const r = await resolveSpawnCwd({ workspaceId: 'nope' }, { ...deps, settleMs: 150 })
    expect(Date.now() - t1).toBeGreaterThanOrEqual(140)
    expect(r.error).toMatch(/workspace no longer exists/)
  })
})

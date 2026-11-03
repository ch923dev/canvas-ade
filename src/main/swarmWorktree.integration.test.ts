import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installRecapHook, removeRecapHook } from './agentRecapMap'
import { claudeProvisioner } from './cliProvisioners/claude'
import {
  createSwarmWorktreeStore,
  swarmWorkerRequest,
  workspaceBranchFor,
  workspaceSlug,
  type SwarmWorktreeStore
} from './swarmWorktree'

/**
 * WS-1 against REAL git — the allocator's mocked unit tests can only assert argv; this proves git
 * agrees. The fixture is a POLYREPO (the project folder holds repos without being one) under a
 * path WITH A SPACE, which is exactly the `M:\expanse` shape the old project-dir probe refused.
 *
 * SAFETY: everything lives under one fresh temp dir that is deleted in `afterAll`. Fixture git
 * strips every inherited `GIT_*` var (a git hook exports `GIT_DIR` for the HOST repo) and writes
 * identity into each throwaway repo's own config — never the global one. The store under test
 * uses its own repo-scoped git env, as in the app.
 */

// Every test here spawns 10–30 real git processes. Alone the file runs in ~5s, but under the full
// suite's parallel load one test took past the 5s default — a timeout, not a failure.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let root = ''
let project = ''
/** An empty excludes file every fixture repo points `core.excludesFile` at (see {@link makeRepo}). */
let noIgnores = ''

function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k]
  return env
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: fixtureEnv(), encoding: 'utf8' }).trim()
}

/**
 * A repo with one commit on `main`. Identity + no signing live in ITS config (the store's commit
 * needs them), and so does an EMPTY excludes file: a box where Claude Code has run carries a
 * global ignore for `.claude/settings.local.json`, and dirtiness must not depend on the box.
 */
function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'itest')
  git(dir, 'config', 'user.email', 'itest@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.excludesFile', noIgnores)
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** `/`-separated, lower-cased: git prints `C:/…`, node joins `C:\…`. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const listed = (repo: string): string[] =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => norm(l.slice('worktree '.length)))

beforeAll(() => {
  // realpath: an 8.3 TEMP (`DEASIS~1`) would otherwise disagree with the long path git prints.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ws1 alloc ')))
  project = join(root, 'my project')
  mkdirSync(project)
  // Written once, before any repo: the nested `beforeAll`s that call makeRepo run after this.
  noIgnores = join(root, 'no-global-ignores')
  writeFileSync(noIgnores, '', 'utf8')
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function storeFor(dir: string): SwarmWorktreeStore {
  return createSwarmWorktreeStore({ getProjectDir: () => dir })
}

describe('WS-1 · polyrepo under a spaced path (real git)', () => {
  let api = ''
  let web = ''

  beforeAll(() => {
    api = makeRepo(join(project, 'api'))
    // `release` is ahead of `main`, so a worktree cut from it is provably NOT cut from HEAD.
    git(api, 'checkout', '-q', '-b', 'release')
    writeFileSync(join(api, 'release.txt'), 'release only\n', 'utf8')
    git(api, 'add', '-A')
    git(api, 'commit', '-q', '-m', 'release only')
    git(api, 'checkout', '-q', 'main')
    // A remote-tracking ref without a network: what a past fetch would have left on disk.
    git(api, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(api, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

    web = makeRepo(join(project, 'web'))
    git(web, 'branch', 'feat/x')

    // Decoys listRepos must skip: dot-folders and node_modules hold repos too, and docs holds none.
    makeRepo(join(project, 'node_modules'))
    makeRepo(join(project, '.hidden'))
    mkdirSync(join(project, 'docs'))
  })

  it('listRepos finds the two repos one level down — the project itself is no repo', async () => {
    const repos = await storeFor(project).listRepos(project)
    // `rel: ''` absent is also the hermeticity check: the temp root is not inside some repo.
    expect(repos.map((r) => r.rel)).toEqual(['api', 'web'])
  })

  it('listBranches reads local + remote-tracking branches off disk', async () => {
    expect(await storeFor(project).listBranches(api)).toEqual({
      ok: true,
      current: 'main',
      local: ['main', 'release'],
      remote: ['origin/main']
    })
  })

  it('create off a non-HEAD base → listed by git → dirty is kept → clean is removed, branch kept', async () => {
    const store = storeFor(project)
    const out = await store.allocate({
      repoDir: api,
      slug: workspaceSlug('API'),
      branch: workspaceBranchFor('API'),
      base: 'release'
    })
    expect(out).toEqual({
      ok: true,
      worktree: join(project, '.canvas', 'worktrees', 'ws-api'),
      branch: 'ws/api'
    })
    if (!out.ok) return
    const wt = out.worktree

    // 1. Cut from `release`, not from the checked-out `main`.
    expect(git(api, 'rev-parse', 'ws/api')).toBe(git(api, 'rev-parse', 'release'))
    expect(git(api, 'rev-parse', 'ws/api')).not.toBe(git(api, 'rev-parse', 'main'))
    expect(existsSync(join(wt, 'release.txt'))).toBe(true)

    // 2. git itself lists it, as a worktree of the SUB-repo.
    expect(listed(api)).toContain(norm(wt))

    // 3. Dirty → every path keeps it on disk.
    writeFileSync(join(wt, 'scratch.txt'), 'uncommitted\n', 'utf8')
    expect(await store.status(wt)).toEqual({ exists: true, dirty: true, changed: 1 })
    expect(await store.dispose(wt, 'keep', 'API')).toMatchObject({ ok: true })
    expect(await store.removeIfClean(wt)).toMatchObject({ removed: false })
    expect(existsSync(wt)).toBe(true)
    expect(listed(api)).toContain(norm(wt))

    // 4. Clean → removed by `git worktree remove` from the owning repo; the branch survives.
    rmSync(join(wt, 'scratch.txt'))
    expect(await store.removeIfClean(wt)).toEqual({ removed: true })
    expect(existsSync(wt)).toBe(false)
    expect(listed(api)).not.toContain(norm(wt))
    expect(git(api, 'branch', '--list', 'ws/api')).toContain('ws/api')
  })

  it('attach checks out an existing branch, and git refuses it a second time', async () => {
    const store = storeFor(project)
    const req = { repoDir: web, slug: workspaceSlug('Feat'), branch: 'feat/x', attach: true }
    const first = await store.allocate(req)
    expect(first).toMatchObject({ ok: true, branch: 'feat/x' })
    if (!first.ok) return
    expect(git(first.worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/x')

    // The second attach gets a fresh leaf (`ws-feat-2`), so the refusal is git's, not ours.
    const second = await store.allocate(req)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.reason).toMatch(/already (used by worktree|checked out)/)
    // `main` is the web repo's own checkout — refused the same way.
    const main = await store.allocate({ ...req, slug: 'ws-main', branch: 'main' })
    expect(main.ok === false && main.reason).toMatch(/already (used by worktree|checked out)/)

    expect(await store.removeIfClean(first.worktree)).toEqual({ removed: true })
    expect(git(web, 'branch', '--list', 'feat/x')).toContain('feat/x')
  })
})

describe('WS-1 · swarm parity on a single-repo project (real git)', () => {
  it('the S3 request still cuts swarm/<run>/<worker> off HEAD under .canvas/worktrees', async () => {
    const solo = makeRepo(join(root, 'solo repo'))
    const store = storeFor(solo)
    const out = await store.allocate(swarmWorkerRequest('a1b2c3d4-zz', 'Builder 1'))
    expect(out).toEqual({
      ok: true,
      worktree: join(solo, '.canvas', 'worktrees', 'builder-1'),
      branch: 'swarm/a1b2c3d4/builder-1'
    })
    if (!out.ok) return
    expect(git(solo, 'rev-parse', 'swarm/a1b2c3d4/builder-1')).toBe(git(solo, 'rev-parse', 'HEAD'))
    expect(await store.removeIfClean(out.worktree)).toEqual({ removed: true })
    expect(git(solo, 'branch', '--list', 'swarm/a1b2c3d4/builder-1')).toContain('builder-1')
  })
})

/**
 * G12 — CHARACTERIZATION, not a spec. When a terminal agent starts in a worktree, the spawn-time
 * providers write Expanse's own config into its cwd (`claudeProvisioner.writeSync` → `.mcp.json`
 * + `.claude/settings.local.json`; the recap hook → the same settings file). Pinned here so WS-8,
 * which owns `cliProvisioners/*`, flips the second half when it makes unsync leave nothing behind.
 * (On a box where Claude Code has run, its global ignore hides the settings file — `.mcp.json`
 * alone still dirties the tree. The fixture's empty excludes file shows the no-ignore case.)
 */
describe('G12 · provisioned agent config vs worktree dirtiness (real git)', () => {
  it('provisioned files read as dirt, and today’s unsync does not make the tree clean again', async () => {
    const repo = makeRepo(join(root, 'g12 repo'))
    const store = storeFor(repo)
    const out = await store.allocate(swarmWorkerRequest('g12g12g1', 'builder'))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const wt = out.worktree
    const scriptPath = join(root, 'app', 'recordSession.js')

    // What a consented `claude` spawn in this worktree writes, via the real writers.
    claudeProvisioner.writeSync(wt, { token: 'itest-token', tier: 'connected', port: 1 })
    installRecapHook({
      projectDir: wt,
      command: 'node',
      scriptPath,
      mapPath: join(root, 'app', 'recap-map.jsonl')
    })
    const porcelain = (): string => git(wt, 'status', '--porcelain', '--untracked-files=all')
    expect(porcelain()).toContain('.mcp.json')
    expect(porcelain()).toContain('.claude/settings.local.json')
    expect(await store.status(wt)).toMatchObject({ exists: true, dirty: true })

    // The existing unsync paths remove OUR entries but leave an emptied settings file behind.
    claudeProvisioner.removeSync(wt)
    removeRecapHook(wt, scriptPath)
    expect(existsSync(join(wt, '.mcp.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8'))).toEqual({})
    expect(porcelain()).toBe('?? .claude/settings.local.json')
    expect(await store.status(wt)).toMatchObject({ dirty: true, changed: 1 })
    // …so the clean-only removal keeps the tree (the locked rule working as designed).
    expect(await store.removeIfClean(wt)).toMatchObject({ removed: false })

    // Fixture teardown: the test, not the product, drops the leftover so git can remove the tree.
    rmSync(join(wt, '.claude'), { recursive: true, force: true })
    expect(await store.removeIfClean(wt)).toEqual({ removed: true })
  })
})

describe('G12 follow-up · dispositions never carry Expanse’s agent config (real git)', () => {
  it('Commit puts the worker’s file on the branch and leaves the token-bearing .mcp.json out', async () => {
    const repo = makeRepo(join(root, 'token repo'))
    const store = storeFor(repo)
    const out = await store.allocate(swarmWorkerRequest('tok12345', 'builder'))
    if (!out.ok) throw new Error(out.reason)
    const wt = out.worktree

    writeFileSync(join(wt, 'work.ts'), 'export const x = 1\n', 'utf8')
    claudeProvisioner.writeSync(wt, { token: 'itest-secret-token', tier: 'connected', port: 1 })

    const r = await store.dispose(wt, 'commit', 'builder')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('committed 1 file onto the branch')

    const onBranch = git(repo, 'ls-tree', '-r', '--name-only', out.branch).split('\n')
    expect(onBranch).toContain('work.ts')
    expect(onBranch).not.toContain('.mcp.json')
    expect(onBranch).not.toContain('.claude/settings.local.json')
    expect(git(repo, 'log', '-p', 'main..' + out.branch)).not.toContain('itest-secret-token')

    // The token file is still in the tree (never committed), so the tree is kept — and says why.
    expect(existsSync(wt)).toBe(true)
    expect(r.detail).toContain("only Expanse's own agent config is left in it")
    expect((await store.dispose(wt, 'discard', 'builder')).detail).toContain('worktree removed')
    expect(existsSync(wt)).toBe(false)
  })

  it('Stash with only Expanse’s config dirty stashes nothing', async () => {
    const repo = makeRepo(join(root, 'stash repo'))
    const store = storeFor(repo)
    const out = await store.allocate(swarmWorkerRequest('stash123', 'builder'))
    if (!out.ok) throw new Error(out.reason)
    claudeProvisioner.writeSync(out.worktree, {
      token: 'itest-secret-token',
      tier: 'connected',
      port: 1
    })

    const r = await store.dispose(out.worktree, 'stash', 'builder')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('nothing to stash')
    expect(git(repo, 'stash', 'list')).toBe('')

    expect((await store.dispose(out.worktree, 'discard', 'builder')).detail).toContain(
      'worktree removed'
    )
  })
})

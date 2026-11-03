import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  branchFor,
  branchLeaf,
  countPorcelain,
  createSwarmWorktreeStore,
  isArgvSafeRef,
  mainWorktreeFrom,
  parseBranchRefs,
  runSlug,
  slugify,
  swarmWorkerRequest,
  workspaceBranchFor,
  workspaceSlug,
  worktreeDirFor,
  type SwarmWorktreeStore
} from './swarmWorktree'

/**
 * The allocator is where the locked worktree rules (`CLAUDE.md` › Git / worktrees) are actually
 * enforced, so the tests that matter most are the REFUSALS: never `git init`, never a destructive
 * op outside this project's worktree dir, never a removal of a dirty tree, and never handing the
 * spawn path a directory we have not proven exists (the `safeCwd`-redirects-to-$HOME trap).
 *
 * `simple-git` is injected through the `gitFor` seam rather than module-mocked, so each test can
 * assert the exact argv git was asked to run.
 */
const PROJECT = 'M:/proj'
const WT = 'M:\\proj\\.canvas\\worktrees\\builder-1'

/** `git worktree list --porcelain` naming `main` as the main worktree (git lists it first). */
const listing = (main: string): string =>
  `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD def\nbranch refs/heads/x\n`

const isWorktreeList = (argv: string[]): boolean => argv[0] === 'worktree' && argv[1] === 'list'

/** The worker-only pathspec: everything except the agent config Expanse provisions. */
const WORKER_SPEC = [
  '--',
  '.',
  ':(exclude).mcp.json',
  ':(exclude).claude/settings.local.json',
  ':(exclude)opencode.json'
]

interface GitStub {
  checkIsRepo: ReturnType<typeof vi.fn>
  revparse: ReturnType<typeof vi.fn>
  branchLocal: ReturnType<typeof vi.fn>
  raw: ReturnType<typeof vi.fn>
}

function makeStore(
  over: {
    project?: string | null
    git?: Partial<GitStub>
    exists?: (p: string) => boolean
    isDir?: (p: string) => boolean
    /** The repo `git worktree list` names as the owner. Default: the project (the swarm shape). */
    owner?: string
  } = {}
): { store: SwarmWorktreeStore; git: GitStub; cwds: string[] } {
  // `worktree list` (the owning-repo read) is answered here, so a test's own `raw` only ever sees
  // the argv its assertions are about.
  const inner = (over.git?.raw ?? vi.fn(async () => '')) as (argv: string[]) => Promise<string>
  const git: GitStub = {
    checkIsRepo: vi.fn(async () => true),
    revparse: vi.fn(async () => PROJECT),
    branchLocal: vi.fn(async () => ({ all: [] as string[] })),
    ...over.git,
    raw: vi.fn(async (argv: string[]) =>
      isWorktreeList(argv) ? listing(over.owner ?? PROJECT) : inner(argv)
    )
  }
  const cwds: string[] = []
  const store = createSwarmWorktreeStore({
    getProjectDir: () => (over.project === undefined ? PROJECT : over.project),
    gitFor: (cwd) => {
      cwds.push(cwd)
      return git as never
    },
    exists: over.exists ?? ((): boolean => false),
    isDir: over.isDir ?? ((): boolean => true)
  })
  return { store, git, cwds }
}

describe('naming', () => {
  it('slugify collapses anything that could escape a path or a git refname', () => {
    // `..`, separators, and every git-refname special (~ ^ : ? * [ \) fall outside [a-z0-9].
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
    expect(slugify('Builder #1')).toBe('builder-1')
    expect(slugify('a~b^c:d?e*f[g\\h')).toBe('a-b-c-d-e-f-g-h')
    expect(slugify('   ')).toBe('worker')
    expect(slugify('')).toBe('worker')
  })

  it('branchFor is run-namespaced and collision-suffixed', () => {
    expect(branchFor('a1b2c3d4-ffff-0000', 'builder-1')).toBe('swarm/a1b2c3d4/builder-1')
    expect(branchFor('a1b2c3d4-ffff-0000', 'builder-1', 1)).toBe('swarm/a1b2c3d4/builder-1-2')
  })

  it('runSlug is 8 chars of the board id, so two runs in one project never collide', () => {
    expect(runSlug('a1b2c3d4-e5f6-7890')).toBe('a1b2c3d4')
    expect(runSlug('')).toBe('run')
  })

  it('worktreeDirFor lands inside the ADR 0009 boundary', () => {
    expect(worktreeDirFor(PROJECT, 'builder-1').replace(/\\/g, '/')).toBe(
      'M:/proj/.canvas/worktrees/builder-1'
    )
  })

  it('branchLeaf is what the card renders', () => {
    expect(branchLeaf('swarm/a1b2c3d4/builder-1')).toBe('builder-1')
    expect(branchLeaf('flat')).toBe('flat')
  })

  it('countPorcelain counts entries, not bytes, and ignores blank lines', () => {
    expect(countPorcelain(' M a.ts\n?? b.ts\n')).toBe(2)
    expect(countPorcelain('')).toBe(0)
    expect(countPorcelain('\n\n')).toBe(0)
  })
})

describe('allocate', () => {
  it('creates the worktree on a new branch off HEAD and returns the pair', async () => {
    const { store, git } = makeStore()
    const out = await store.allocate(swarmWorkerRequest('a1b2c3d4-x', 'builder-1'))
    expect(out).toMatchObject({ ok: true, branch: 'swarm/a1b2c3d4/builder-1' })
    // Base is HEAD, deliberately NOT `main`: every worker starts from the commit the human was
    // looking at, and branching off main would silently rebase the whole swarm.
    expect(git.raw).toHaveBeenCalledWith([
      'worktree',
      'add',
      '-b',
      'swarm/a1b2c3d4/builder-1',
      expect.stringContaining('builder-1'),
      'HEAD'
    ])
  })

  it('🔒 REFUSES a non-repo project and never runs `git init` (the locked opt-in rule)', async () => {
    const { store, git } = makeStore({ git: { checkIsRepo: vi.fn(async () => false) } })
    const out = await store.allocate(swarmWorkerRequest('r', 'builder-1'))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('never runs `git init`')
    expect(git.raw).not.toHaveBeenCalled()
  })

  it('🔒 REFUSES when the created path is not a directory — the safeCwd guard', async () => {
    // git said ok but the dir is absent: handing this to the spawn path would silently redirect
    // the builder to $HOME with a green status (A6-3). Refuse instead.
    const { store } = makeStore({ isDir: () => false })
    const out = await store.allocate(swarmWorkerRequest('r', 'builder-1'))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('home folder')
  })

  it("refuses with git's own message when `worktree add` fails", async () => {
    const { store } = makeStore({
      git: {
        raw: vi.fn(async () => {
          throw new Error('fatal: invalid reference: HEAD')
        })
      }
    })
    const out = await store.allocate(swarmWorkerRequest('r', 'builder-1'))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('fatal: invalid reference')
  })

  it('refuses with no project open rather than guessing a location', async () => {
    const { store } = makeStore({ project: null })
    expect((await store.allocate(swarmWorkerRequest('r', 'builder-1'))).ok).toBe(false)
  })

  it('skips a taken path AND a taken branch independently', async () => {
    const { store } = makeStore({
      // `builder-1` dir exists, and `…-2` branch exists → the first free pair is attempt 3.
      exists: (p) => p.endsWith('builder-1'),
      git: { branchLocal: vi.fn(async () => ({ all: ['swarm/rrrr/builder-1-2'] })) }
    })
    const out = await store.allocate(swarmWorkerRequest('rrrr', 'builder-1'))
    expect(out).toMatchObject({ ok: true, branch: 'swarm/rrrr/builder-1-3' })
  })
})

describe('status', () => {
  it('reports the changed count and dirtiness from porcelain', async () => {
    const { store } = makeStore({ git: { raw: vi.fn(async () => ' M a.ts\n?? b.ts\n') } })
    expect(await store.status(WT)).toEqual({ exists: true, dirty: true, changed: 2 })
  })

  it('clean tree reads clean', async () => {
    const { store } = makeStore({ git: { raw: vi.fn(async () => '') } })
    expect(await store.status(WT)).toEqual({ exists: true, dirty: false, changed: 0 })
  })

  it('a missing directory reads as not-exists', async () => {
    const { store } = makeStore({ isDir: () => false })
    expect(await store.status(WT)).toEqual({ exists: false, dirty: false, changed: 0 })
  })

  it('🔒 an UNREADABLE tree reads as DIRTY, never clean — clean is what authorises removal', async () => {
    const { store } = makeStore({
      git: {
        raw: vi.fn(async () => {
          throw new Error('index.lock')
        })
      }
    })
    expect(await store.status(WT)).toMatchObject({ exists: true, dirty: true })
  })
})

describe('owns — the containment guard on every destructive path', () => {
  it("accepts a path under this project's worktree dir", () => {
    const { store } = makeStore()
    expect(store.owns(WT)).toBe(true)
  })

  it('rejects the root itself, a sibling with a shared prefix, and anything outside', () => {
    const { store } = makeStore()
    expect(store.owns('M:/proj/.canvas/worktrees')).toBe(false)
    expect(store.owns('M:/proj/.canvas/worktrees-old/x')).toBe(false)
    expect(store.owns('M:/proj/src')).toBe(false)
    expect(store.owns('M:/other/.canvas/worktrees/x')).toBe(false)
    expect(store.owns('')).toBe(false)
  })

  it('rejects everything once the project has switched — which makes a mass `gone` sweep a no-op', () => {
    const { store } = makeStore({ project: 'M:/other' })
    expect(store.owns(WT)).toBe(false)
  })
})

describe('removeIfClean — the locked keep-on-dirty rule', () => {
  it('removes a clean tree with NO --force, and keeps the branch', async () => {
    const raw = vi.fn(async (_argv: string[]) => '')
    const { store } = makeStore({ git: { raw } })
    expect(await store.removeIfClean(WT)).toEqual({ removed: true })
    expect(raw).toHaveBeenCalledWith(['worktree', 'remove', WT])
    // Never --force, and never a branch delete: the branch is the human's record of the work.
    const argv = raw.mock.calls.flatMap((c) => c[0] as string[])
    expect(argv).not.toContain('--force')
    expect(argv).not.toContain('-f')
    expect(argv).not.toContain('branch')
  })

  it('🔒 runs the removal from the OWNING REPO, never from inside the tree it deletes', async () => {
    // A git child spawned with its cwd set to the doomed directory holds it open, and Windows
    // refuses to delete any process's cwd — `git worktree remove` then fails "Permission denied"
    // and the worktree leaks. Found by the e2e against a real repo; this is its unit guard.
    const raw = vi.fn(async (_argv: string[]) => '')
    const { store, cwds } = makeStore({ git: { raw } })
    expect(await store.removeIfClean(WT)).toEqual({ removed: true })
    // The LAST git instance built — the one that ran `worktree remove` — was rooted at the repo
    // that owns the tree, which for the swarm is the project.
    expect(cwds[cwds.length - 1]).toBe(PROJECT)
    expect(cwds[cwds.length - 1]).not.toBe(WT)
  })

  it('🔒 a polyrepo tree is removed from ITS repo, not from the project (which is no repo)', async () => {
    const raw = vi.fn(async (_argv: string[]) => '')
    const { store, cwds } = makeStore({ git: { raw }, owner: 'M:/proj/api' })
    expect(await store.removeIfClean(WT)).toEqual({ removed: true })
    expect(raw).toHaveBeenCalledWith(['worktree', 'remove', WT])
    expect(cwds[cwds.length - 1]).toBe('M:/proj/api')
  })

  it('refuses to remove when the owning repo cannot be read, rather than guessing one', async () => {
    const raw = vi.fn(async (_argv: string[]) => '')
    const { store } = makeStore({ git: { raw }, owner: '' })
    const out = await store.removeIfClean(WT)
    expect(out.removed).toBe(false)
    expect(out.reason).toContain('owns it')
    expect(raw.mock.calls.flatMap((c) => c[0] as string[])).not.toContain('remove')
  })

  it('🔒 KEEPS a dirty tree on disk and says why (not an error — it is the policy)', async () => {
    const raw = vi.fn(async (_argv: string[]) => ' M a.ts\n')
    const { store } = makeStore({ git: { raw } })
    const out = await store.removeIfClean(WT)
    expect(out.removed).toBe(false)
    expect(out.reason).toContain('kept on disk')
    expect(raw.mock.calls.flatMap((c) => c[0] as string[])).not.toContain('remove')
  })

  it('🔒 refuses a path this project does not own, without touching git at all', async () => {
    const raw = vi.fn(async (_argv: string[]) => '')
    const { store } = makeStore({ git: { raw } })
    expect(await store.removeIfClean('M:/somewhere/else')).toMatchObject({ removed: false })
    expect(raw).not.toHaveBeenCalled()
  })
})

describe('dispose — the four named choices', () => {
  const dirty = (): { raw: ReturnType<typeof vi.fn> } => {
    // `status --porcelain` answers dirty until a removal is attempted; every other raw resolves.
    const raw = vi.fn(async (argv: string[]) => (argv[0] === 'status' ? ' M a.ts\n M b.ts\n' : ''))
    return { raw }
  }

  it('keep runs NOTHING and says the tree is still there', async () => {
    const { raw } = dirty()
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'keep', 'builder-1')
    expect(out.ok).toBe(true)
    expect(out.detail).toContain('kept on disk')
    expect(raw.mock.calls.flatMap((c) => c[0] as string[])).not.toContain('commit')
  })

  it('commit adds + commits onto the worker branch, then removes', async () => {
    let removed = false
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') return removed ? '' : ' M a.ts\n M b.ts\n'
      if (argv[0] === 'commit') removed = true // the tree is clean once committed
      return ''
    })
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'commit', 'builder-1')
    expect(out.ok).toBe(true)
    expect(out.detail).toContain('committed 2 files')
    expect(out.detail).toContain('worktree removed, branch kept')
    expect(raw).toHaveBeenCalledWith(['add', '-A', ...WORKER_SPEC])
    expect(raw).toHaveBeenCalledWith([
      'commit',
      '-m',
      'swarm(builder-1): preserve uncommitted work'
    ])
  })

  it('stash pushes untracked too', async () => {
    let stashed = false
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') return stashed ? '' : ' M a.ts\n'
      if (argv[0] === 'stash') stashed = true
      return ''
    })
    const { store } = makeStore({ git: { raw } })
    await store.dispose(WT, 'stash', 'builder-1')
    expect(raw).toHaveBeenCalledWith([
      'stash',
      'push',
      '-u',
      '-m',
      'swarm(builder-1) preserved work',
      ...WORKER_SPEC
    ])
  })

  it("🔒 commit + stash leave Expanse's agent config out — it carries a live bearer token", async () => {
    // Every argv that can put a file on a branch or into a stash carries the exclusions.
    for (const choice of ['commit', 'stash'] as const) {
      const raw = vi.fn(async (argv: string[]) => (argv[0] === 'status' ? '?? work.ts\n' : ''))
      const { store } = makeStore({ git: { raw } })
      await store.dispose(WT, choice, 'builder-1')
      const writes = raw.mock.calls
        .map((c) => c[0] as string[])
        .filter((a) => a[0] === 'add' || a[0] === 'stash')
      expect(writes.length).toBeGreaterThan(0)
      for (const a of writes) expect(a.slice(-WORKER_SPEC.length)).toEqual(WORKER_SPEC)
    }
  })

  it('when only Expanse config is dirty, commit/stash write NOTHING and say Discard clears it', async () => {
    // The raw status still reads dirty (`.mcp.json`), but the worker-only view is empty.
    for (const choice of ['commit', 'stash'] as const) {
      const raw = vi.fn(async (argv: string[]) => {
        if (argv[0] !== 'status') return ''
        return argv.includes(':(exclude).mcp.json') ? '' : '?? .mcp.json\n'
      })
      const { store } = makeStore({ git: { raw } })
      const out = await store.dispose(WT, choice, 'builder-1')
      expect(out.ok).toBe(true)
      expect(out.detail).toContain(`nothing to ${choice}`)
      expect(out.detail).toContain('Discard removes it')
      const verbs = raw.mock.calls.map((c) => (c[0] as string[])[0])
      expect(verbs).not.toContain('add')
      expect(verbs).not.toContain('commit')
      expect(verbs).not.toContain('stash')
    }
  })

  it('a tree still dirty after a commit is explained: only Expanse config is left', async () => {
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] !== 'status') return ''
      return argv.includes(':(exclude).mcp.json') ? '?? work.ts\n' : '?? .mcp.json\n?? work.ts\n'
    })
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'commit', 'builder-1')
    expect(out.detail).toContain('committed 1 file onto the branch')
    expect(out.detail).toContain("only Expanse's own agent config is left in it")
  })

  it('discard resets the working tree only — never history, never the branch', async () => {
    let cleaned = false
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') return cleaned ? '' : ' M a.ts\n'
      if (argv[0] === 'clean') cleaned = true
      return ''
    })
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'discard', 'builder-1')
    expect(out.ok).toBe(true)
    expect(raw).toHaveBeenCalledWith(['checkout', '--', '.'])
    expect(raw).toHaveBeenCalledWith(['clean', '-fd'])
    const argv = raw.mock.calls.flatMap((c) => c[0] as string[])
    expect(argv).not.toContain('reset') // no history rewrite
    expect(argv).not.toContain('branch') // the branch always survives
  })

  it('🔒 a tree that stopped being dirty mid-flight is just removed — no destructive op on stale intent', async () => {
    // TOCTOU: the worker committed between the row being drawn and the human clicking Discard.
    const { store } = makeStore({ git: { raw: vi.fn(async () => '') } })
    const out = await store.dispose(WT, 'discard', 'builder-1')
    expect(out.ok).toBe(true)
    expect(out.detail).toContain('already clean')
  })

  it('reports the disposition as DONE even when the removal afterwards fails', async () => {
    // The work was preserved; saying "failed" would imply it was not.
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') return ' M a.ts\n'
      if (argv[0] === 'stash') return ''
      throw new Error('worktree is locked')
    })
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'stash', 'builder-1')
    expect(out.ok).toBe(true)
    expect(out.detail).toContain('stashed 1 file')
    expect(out.detail).toContain('could not be removed')
  })

  it('🔒 refuses a path this project does not own', async () => {
    const { store } = makeStore()
    expect(await store.dispose('M:/elsewhere/x', 'discard', 'x')).toMatchObject({ ok: false })
  })

  it('surfaces a failed git write as a failure rather than removing the tree anyway', async () => {
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') return ' M a.ts\n'
      throw new Error('nothing to commit')
    })
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'commit', 'builder-1')
    expect(out.ok).toBe(false)
    expect(out.detail).toContain('commit failed')
    expect(raw.mock.calls.flatMap((c) => c[0] as string[])).not.toContain('remove')
  })
})

describe('no recursive delete exists anywhere in this module', () => {
  it('every git argv across allocate/remove/dispose stays inside the worktree vocabulary', async () => {
    let clean = false
    const raw = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'status') return clean ? '' : ' M a.ts\n'
      if (argv[0] === 'clean') clean = true
      return ''
    })
    const { store } = makeStore({ git: { raw } })
    await store.allocate(swarmWorkerRequest('r', 'b1'))
    await store.dispose(WT, 'discard', 'b1')
    const argv = raw.mock.calls.flatMap((c) => c[0] as string[])
    // `git worktree remove` only — the whole reason `remove-worktree.ps1` exists is that a
    // recursive delete can follow a node_modules junction into the real repo.
    expect(argv.filter((a) => a === 'remove')).toHaveLength(1)
    expect(argv).not.toContain('--force')
  })
})

// ── WS-1: the one allocator, generalized for Project Workspaces ─────────────────────────────

/** Per-folder git: `repos` maps a folder to its toplevel; anything else is not a repo. */
function polyStore(
  repos: Record<string, string>,
  over: {
    branches?: string[]
    raw?: (argv: string[]) => Promise<string>
    prefix?: Record<string, string>
    listDirs?: (p: string) => string[]
    exists?: (p: string) => boolean
  } = {}
): { store: SwarmWorktreeStore; raw: ReturnType<typeof vi.fn>; cwds: string[] } {
  const raw = vi.fn(over.raw ?? (async (_argv: string[]) => ''))
  const cwds: string[] = []
  const store = createSwarmWorktreeStore({
    getProjectDir: () => PROJECT,
    gitFor: (cwd) => {
      cwds.push(cwd)
      // listRepos hands git `join()`ed paths (backslashes on Windows); key on the `/` form.
      const key = cwd.replace(/\\/g, '/')
      return {
        checkIsRepo: vi.fn(async () => key in repos),
        revparse: vi.fn(async (args: string[]) =>
          args[0] === '--show-prefix' ? (over.prefix?.[key] ?? '') : (repos[key] ?? '')
        ),
        branchLocal: vi.fn(async () => ({ all: over.branches ?? [] })),
        raw
      } as never
    },
    exists: over.exists ?? ((): boolean => false),
    isDir: (): boolean => true,
    listDirs: over.listDirs
  })
  return { store, raw, cwds }
}

const API = 'M:/proj/api'
const addArgv = (raw: ReturnType<typeof vi.fn>): string[] | undefined =>
  raw.mock.calls.map((c) => c[0] as string[]).find((a) => a[0] === 'worktree' && a[1] === 'add')

describe('WS-1 · naming', () => {
  it('the swarm request is the S3 shape exactly: the project as the repo, base HEAD', () => {
    // No repoDir / base / attach: the allocator's defaults ARE the swarm's behaviour.
    expect(swarmWorkerRequest('a1b2c3d4-x', 'Builder #1')).toEqual({
      slug: 'builder-1',
      branch: 'swarm/a1b2c3d4/builder-1'
    })
  })

  it('workspaces take the ws- leaf and the ws/ branch namespace (O-10)', () => {
    expect(workspaceSlug('API')).toBe('ws-api')
    expect(workspaceSlug('')).toBe('ws-worker')
    expect(workspaceSlug('x'.repeat(200)).length).toBeLessThanOrEqual(48)
    expect(workspaceBranchFor('Uploader v2')).toBe('ws/uploader-v2')
  })

  it('isArgvSafeRef refuses an option-shaped or whitespace ref and leaves the rest to git', () => {
    expect(isArgvSafeRef('release')).toBe(true)
    expect(isArgvSafeRef('origin/feat/x')).toBe(true)
    expect(isArgvSafeRef('HEAD')).toBe(true)
    expect(isArgvSafeRef('--force')).toBe(false)
    expect(isArgvSafeRef('-b')).toBe(false)
    expect(isArgvSafeRef('a b')).toBe(false)
    expect(isArgvSafeRef('a\nb')).toBe(false)
    expect(isArgvSafeRef('')).toBe(false)
  })

  it('parseBranchRefs splits local from remote-tracking and drops a remote HEAD', () => {
    const out = [
      'refs/heads/main',
      'refs/heads/feat/x',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
      'refs/remotes/upstream/release',
      'refs/tags/v1',
      ''
    ].join('\n')
    expect(parseBranchRefs(out)).toEqual({
      local: ['main', 'feat/x'],
      remote: ['origin/main', 'upstream/release']
    })
  })

  it('mainWorktreeFrom reads the first listed worktree — the main one', () => {
    expect(mainWorktreeFrom(listing('M:/proj/api'))).toBe('M:/proj/api')
    expect(mainWorktreeFrom('')).toBeNull()
  })
})

describe('WS-1 · allocate', () => {
  it('swarm parity: probes the PROJECT and runs the S3 argv unchanged', async () => {
    const { store, git, cwds } = makeStore()
    const out = await store.allocate(swarmWorkerRequest('a1b2c3d4-x', 'builder-1'))
    expect(out).toEqual({
      ok: true,
      worktree: worktreeDirFor(PROJECT, 'builder-1'),
      branch: 'swarm/a1b2c3d4/builder-1'
    })
    expect(cwds[0]).toBe(PROJECT)
    expect(git.raw).toHaveBeenCalledWith([
      'worktree',
      'add',
      '-b',
      'swarm/a1b2c3d4/builder-1',
      worktreeDirFor(PROJECT, 'builder-1'),
      'HEAD'
    ])
  })

  it('polyrepo: probes repoDir (the project is no repo) and still lands under .canvas/worktrees', async () => {
    const { store, raw, cwds } = polyStore({ [API]: API })
    const out = await store.allocate({ repoDir: API, slug: 'ws-api', branch: 'ws/api' })
    expect(out).toEqual({
      ok: true,
      worktree: worktreeDirFor(PROJECT, 'ws-api'),
      branch: 'ws/api'
    })
    expect(cwds).not.toContain(PROJECT) // the project folder is never asked to be a repo
    expect(cwds[cwds.length - 1]).toBe(API) // the write ran in the sub-repo
    expect(addArgv(raw)).toEqual([
      'worktree',
      'add',
      '-b',
      'ws/api',
      worktreeDirFor(PROJECT, 'ws-api'),
      'HEAD'
    ])
  })

  it('a named base replaces HEAD (O-10: api → release)', async () => {
    const { store, raw } = polyStore({ [API]: API })
    await store.allocate({ repoDir: API, slug: 'ws-api', branch: 'ws/api', base: 'release' })
    expect(addArgv(raw)?.at(-1)).toBe('release')
  })

  it('🔒 refuses a repoDir outside the project, `..` escapes included, without touching git', async () => {
    for (const repoDir of ['M:/other', 'M:/proj-old/api', 'M:/proj/../other']) {
      const { store, cwds } = polyStore({ [repoDir]: repoDir })
      const out = await store.allocate({ repoDir, slug: 'ws-x', branch: 'ws/x' })
      expect(out.ok).toBe(false)
      expect(out.ok === false && out.reason).toContain('outside the open project')
      expect(cwds).toEqual([])
    }
  })

  it('🔒 a non-repo sub-folder refuses and never runs `git init`', async () => {
    const { store, raw } = polyStore({})
    const out = await store.allocate({ repoDir: API, slug: 'ws-api', branch: 'ws/api' })
    expect(out.ok === false && out.reason).toContain('never runs `git init`')
    expect(raw).not.toHaveBeenCalled()
  })

  it('🔒 refuses an option-shaped base or branch before git sees it', async () => {
    for (const req of [
      { slug: 'ws-api', branch: 'ws/api', base: '--force' },
      { slug: 'ws-api', branch: '-D' }
    ]) {
      const { store, cwds } = polyStore({ [API]: API })
      const out = await store.allocate({ repoDir: API, ...req })
      expect(out.ok === false && out.reason).toContain('not a usable branch name')
      expect(cwds).toEqual([])
    }
  })

  it('collision-suffixes the leaf and the new branch in step', async () => {
    const { store } = polyStore(
      { [API]: API },
      { branches: ['ws/api'], exists: (p) => p.replace(/\\/g, '/').endsWith('/ws-api-2') }
    )
    // attempt 0: branch taken · attempt 1: dir taken · attempt 2: both free.
    const out = await store.allocate({ repoDir: API, slug: 'ws-api', branch: 'ws/api' })
    expect(out).toMatchObject({ ok: true, branch: 'ws/api-3' })
    expect(out.ok && out.worktree.replace(/\\/g, '/')).toMatch(/\/ws-api-3$/)
  })
})

describe('WS-1 · attach an existing branch', () => {
  it('checks the branch out as it is: no -b, no base', async () => {
    const { store, raw } = polyStore({ [API]: API }, { branches: ['main', 'feat/x'] })
    const out = await store.allocate({
      repoDir: API,
      slug: 'ws-feat',
      branch: 'feat/x',
      attach: true
    })
    expect(out).toMatchObject({ ok: true, branch: 'feat/x' })
    expect(addArgv(raw)).toEqual(['worktree', 'add', worktreeDirFor(PROJECT, 'ws-feat'), 'feat/x'])
  })

  it('suffixes the leaf only — the branch stays the one the human picked', async () => {
    const { store } = polyStore(
      { [API]: API },
      { branches: ['feat/x'], exists: (p) => p.replace(/\\/g, '/').endsWith('/ws-feat') }
    )
    const out = await store.allocate({
      repoDir: API,
      slug: 'ws-feat',
      branch: 'feat/x',
      attach: true
    })
    expect(out).toMatchObject({ ok: true, branch: 'feat/x' })
    expect(out.ok && out.worktree.replace(/\\/g, '/')).toMatch(/\/ws-feat-2$/)
  })

  it("surfaces git's refusal when the branch is checked out elsewhere", async () => {
    const { store } = polyStore(
      { [API]: API },
      {
        branches: ['main'],
        raw: async () => {
          throw new Error("fatal: 'main' is already used by worktree at 'M:/proj/api'")
        }
      }
    )
    const out = await store.allocate({ repoDir: API, slug: 'ws-m', branch: 'main', attach: true })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('already used by worktree')
  })

  it('refuses a branch that is not local rather than checking out a detached HEAD', async () => {
    const { store, raw } = polyStore({ [API]: API }, { branches: ['main'] })
    const out = await store.allocate({
      repoDir: API,
      slug: 'ws-r',
      branch: 'origin/release',
      attach: true
    })
    expect(out.ok === false && out.reason).toContain('no local branch')
    expect(addArgv(raw)).toBeUndefined()
  })

  it('refuses a base with attach — a base only applies to a new branch', async () => {
    const { store, cwds } = polyStore({ [API]: API }, { branches: ['main'] })
    const out = await store.allocate({
      repoDir: API,
      slug: 'ws-m',
      branch: 'main',
      base: 'release',
      attach: true
    })
    expect(out.ok).toBe(false)
    expect(cwds).toEqual([])
  })
})

describe('WS-1 · owns resists `..`', () => {
  it('a path that climbs out of the worktree root is not owned', () => {
    const { store } = makeStore()
    expect(store.owns('M:/proj/.canvas/worktrees/../../other')).toBe(false)
    expect(store.owns('M:\\proj\\.canvas\\worktrees\\..\\..\\x')).toBe(false)
    expect(store.owns('M:/proj/.canvas/worktrees/x/..')).toBe(false) // the root itself
    expect(store.owns('M:/proj/.canvas/worktrees/a/../b')).toBe(true) // still inside
  })
})

describe('WS-1 · listRepos', () => {
  const kids = (): string[] => [
    '.canvas',
    '.git',
    '.hidden',
    'node_modules',
    'web',
    'api',
    'docs',
    'broken'
  ]
  const gitAt = (p: string): boolean =>
    /\/(api|web|broken|\.hidden|node_modules|\.canvas)\/\.git$/.test(p.replace(/\\/g, '/'))

  it('a polyrepo root lists each repo one level down and skips dot-folders + node_modules', async () => {
    const { store, cwds } = polyStore(
      {},
      { listDirs: kids, exists: gitAt, prefix: { [`${PROJECT}/broken`]: 'broken/' } }
    )
    const repos = await store.listRepos(PROJECT)
    expect(repos.map((r) => r.rel)).toEqual(['api', 'web'])
    const probed = cwds.map((c) => c.replace(/\\/g, '/'))
    for (const skipped of ['.canvas', '.hidden', 'node_modules', 'docs']) {
      expect(probed).not.toContain(`${PROJECT}/${skipped}`) // never even asked
    }
  })

  it('a root that is itself a repo comes first', async () => {
    const { store } = polyStore({ [PROJECT]: PROJECT }, { listDirs: () => [], exists: gitAt })
    expect(await store.listRepos(PROJECT)).toEqual([{ dir: PROJECT, rel: '' }])
  })
})

describe('WS-1 · listBranches', () => {
  const refs =
    'refs/heads/main\nrefs/heads/release\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\n'

  it('returns local + remote-tracking + the current branch, and never fetches', async () => {
    const { store, raw } = polyStore(
      { [API]: API },
      { raw: async (argv) => (argv[0] === 'for-each-ref' ? refs : 'main\n') }
    )
    expect(await store.listBranches(API)).toEqual({
      ok: true,
      current: 'main',
      local: ['main', 'release'],
      remote: ['origin/main']
    })
    const argv = raw.mock.calls.flatMap((c) => c[0] as string[])
    expect(argv).not.toContain('fetch')
    expect(argv).not.toContain('pull')
  })

  it('a detached HEAD reads as no current branch', async () => {
    const { store } = polyStore(
      { [API]: API },
      {
        raw: async (argv) => {
          if (argv[0] === 'symbolic-ref') throw new Error('exit 1')
          return refs
        }
      }
    )
    expect(await store.listBranches(API)).toMatchObject({ ok: true, current: null })
  })

  it('🔒 refuses a repo outside the project, and a non-repo folder', async () => {
    const { store: outside } = polyStore({ 'M:/other': 'M:/other' })
    expect(await outside.listBranches('M:/other')).toMatchObject({ ok: false })
    const { store: plain } = polyStore({})
    expect(await plain.listBranches(API)).toMatchObject({ ok: false })
  })
})

beforeEach(() => {
  vi.clearAllMocks()
})

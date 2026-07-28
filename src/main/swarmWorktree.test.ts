import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  branchFor,
  branchLeaf,
  countPorcelain,
  createSwarmWorktreeStore,
  runSlug,
  slugify,
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
  } = {}
): { store: SwarmWorktreeStore; git: GitStub; cwds: string[] } {
  const git: GitStub = {
    checkIsRepo: vi.fn(async () => true),
    revparse: vi.fn(async () => PROJECT),
    branchLocal: vi.fn(async () => ({ all: [] as string[] })),
    raw: vi.fn(async () => ''),
    ...over.git
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
    const out = await store.allocate('a1b2c3d4-x', 'builder-1')
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
    const out = await store.allocate('r', 'builder-1')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('never runs `git init`')
    expect(git.raw).not.toHaveBeenCalled()
  })

  it('🔒 REFUSES when the created path is not a directory — the safeCwd guard', async () => {
    // git said ok but the dir is absent: handing this to the spawn path would silently redirect
    // the builder to $HOME with a green status (A6-3). Refuse instead.
    const { store } = makeStore({ isDir: () => false })
    const out = await store.allocate('r', 'builder-1')
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
    const out = await store.allocate('r', 'builder-1')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('fatal: invalid reference')
  })

  it('refuses with no project open rather than guessing a location', async () => {
    const { store } = makeStore({ project: null })
    expect((await store.allocate('r', 'builder-1')).ok).toBe(false)
  })

  it('skips a taken path AND a taken branch independently', async () => {
    const { store } = makeStore({
      // `builder-1` dir exists, and `…-2` branch exists → the first free pair is attempt 3.
      exists: (p) => p.endsWith('builder-1'),
      git: { branchLocal: vi.fn(async () => ({ all: ['swarm/rrrr/builder-1-2'] })) }
    })
    const out = await store.allocate('rrrr', 'builder-1')
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

  it('🔒 runs the removal from the PROJECT, never from inside the tree it deletes', async () => {
    // A git child spawned with its cwd set to the doomed directory holds it open, and Windows
    // refuses to delete any process's cwd — `git worktree remove` then fails "Permission denied"
    // and the worktree leaks. Found by the e2e against a real repo; this is its unit guard.
    const raw = vi.fn(async (_argv: string[]) => '')
    const { store, cwds } = makeStore({ git: { raw } })
    expect(await store.removeIfClean(WT)).toEqual({ removed: true })
    // The LAST git instance built — the one that ran `worktree remove` — was rooted at the project.
    expect(cwds[cwds.length - 1]).toBe(PROJECT)
    expect(cwds[cwds.length - 1]).not.toBe(WT)
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
      if (argv[1] === 'commit') removed = true // the tree is clean once committed
      return ''
    })
    const { store } = makeStore({ git: { raw } })
    const out = await store.dispose(WT, 'commit', 'builder-1')
    expect(out.ok).toBe(true)
    expect(out.detail).toContain('committed 2 files')
    expect(raw).toHaveBeenCalledWith(['add', '-A'])
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
      'swarm(builder-1) preserved work'
    ])
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
    await store.allocate('r', 'b1')
    await store.dispose(WT, 'discard', 'b1')
    const argv = raw.mock.calls.flatMap((c) => c[0] as string[])
    // `git worktree remove` only — the whole reason `remove-worktree.ps1` exists is that a
    // recursive delete can follow a node_modules junction into the real repo.
    expect(argv.filter((a) => a === 'remove')).toHaveLength(1)
    expect(argv).not.toContain('--force')
  })
})

beforeEach(() => {
  vi.clearAllMocks()
})

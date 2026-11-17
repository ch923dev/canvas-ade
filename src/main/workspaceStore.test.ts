import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import type { SimpleGit } from 'simple-git'
import {
  createWorkspaceStore,
  DEPS_PROMPT,
  NOT_A_REPO,
  trustGateShowing,
  type WorkspaceStoreDeps
} from './workspaceStore'
import type { SwarmWorktreeStore } from './swarmWorktree'
import { resolveWithinRoot } from './pathSafe'
import type { WorkspaceMirror } from './workspaceMirror'

// WS-4 lifecycle (design §4.3) against injected fakes: no real git, no real fs. The real-repo
// path is covered by e2e/workspaceLifecycle.e2e.ts.

// resolve(): absolute on every OS (join('C:', …) is RELATIVE on POSIX — the Linux CI leg).
const PROJECT = resolve('/work', 'my project')
const at = (...p: string[]): string => join(PROJECT, ...p)

/** A fake simple-git per folder: which folders are repos, their top, their branch. */
interface FakeRepo {
  top: string
  current?: string | null
}

function fakeGit(repos: Record<string, FakeRepo>): {
  gitFor: (cwd: string) => SimpleGit
  calls: string[]
} {
  const calls: string[] = []
  const gitFor = (cwd: string): SimpleGit => {
    const repo = Object.entries(repos).find(
      ([dir]) => cwd === dir || cwd.startsWith(dir + '\\') || cwd.startsWith(dir + '/')
    )?.[1]
    return {
      checkIsRepo: async () => {
        calls.push(`checkIsRepo ${cwd}`)
        return repo !== undefined
      },
      revparse: async (args: string[]) => {
        calls.push(`revparse ${args.join(' ')} @ ${cwd}`)
        if (args[0] === '--show-toplevel') return repo!.top
        if (args[0] === 'HEAD') return 'abc123\n'
        return ''
      },
      raw: async (args: string[]) => {
        calls.push(`raw ${args.join(' ')} @ ${cwd}`)
        if (args[0] === 'symbolic-ref') {
          if (repo?.current === null) throw new Error('detached')
          return `${repo?.current ?? 'main'}\n`
        }
        return ''
      },
      // A tripwire: nothing in WS-4 may ever initialise a repository.
      init: async () => {
        throw new Error('git init must never run')
      }
    } as unknown as SimpleGit
  }
  return { gitFor, calls }
}

function fakeWorktrees(over: Partial<SwarmWorktreeStore> = {}): SwarmWorktreeStore {
  return {
    allocate: vi.fn(async (req) => ({
      ok: true as const,
      worktree: at('.canvas', 'worktrees', req.slug),
      branch: req.branch
    })),
    status: vi.fn(async () => ({ exists: true, dirty: false, changed: 0 })),
    removeIfClean: vi.fn(async () => ({ removed: true })),
    dispose: vi.fn(async () => ({ ok: true, detail: 'done' })),
    owns: vi.fn(
      (p: string) =>
        p.startsWith(at('.canvas', 'worktrees') + '\\') ||
        p.startsWith(at('.canvas', 'worktrees') + '/')
    ),
    listRepos: vi.fn(async () => [
      { dir: PROJECT, rel: '' },
      { dir: at('api'), rel: 'api' }
    ]),
    listBranches: vi.fn(async () => ({
      ok: true as const,
      current: 'main',
      local: ['main', 'release'],
      remote: ['origin/main']
    })),
    ...over
  }
}

const dirs = new Set<string>()

function make(
  over: Partial<WorkspaceStoreDeps> = {},
  repos: Record<string, FakeRepo> = { [at('api')]: { top: at('api'), current: 'main' } }
): { store: ReturnType<typeof createWorkspaceStore>; deps: WorkspaceStoreDeps; calls: string[] } {
  const { gitFor, calls } = fakeGit(repos)
  const deps: WorkspaceStoreDeps = {
    getProjectDir: () => PROJECT,
    worktrees: fakeWorktrees(),
    getWorkspace: () => undefined,
    liveTerminals: () => [],
    terminalCwd: () => undefined,
    sendPrompt: vi.fn(async () => ({ delivery: 'ready' as const })),
    awaitReady: async () => 'ready',
    screenTail: () => '',
    gitFor,
    isDir: (p) => dirs.has(p),
    realpath: async (p) => p,
    // Lexical containment: the fake paths exist nowhere, so the physical realpath re-check is the
    // e2e's job (a real repo under a spaced temp path).
    resolveWithin: async (root, rel) => resolveWithinRoot(root, rel),
    newId: () => 'ws-id-1',
    now: () => 1000,
    sleep: async () => undefined,
    ...over
  }
  return { store: createWorkspaceStore(deps), deps, calls }
}

beforeEach(() => {
  dirs.clear()
  for (const d of [PROJECT, at('api'), at('docs'), at('api', 'src')]) dirs.add(d)
})

describe('probe', () => {
  it('refuses a folder outside the project (O-7), lexical or absolute', async () => {
    const { store } = make()
    for (const bad of ['../elsewhere', 'C:/x', '/etc']) {
      const r = await store.probe(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('outside this project')
    }
  })

  it("refuses Expanse's own .canvas folder", async () => {
    const r = await make().store.probe('.canvas/worktrees/ws-api')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('.canvas') })
  })

  it('refuses a path that is not a folder', async () => {
    const r = await make().store.probe('nope')
    expect(r).toEqual({ ok: false, reason: 'nope/ is not a folder in this project.' })
  })

  it('a non-repo folder offers folder-as-is only — and never runs git init', async () => {
    const r = await make().store.probe('docs')
    expect(r).toEqual({ ok: true, root: 'docs', gitReason: NOT_A_REPO })
    expect(NOT_A_REPO).toContain('never runs `git init`')
  })

  it('a repo folder reports its project-relative repo root + current branch', async () => {
    const r = await make().store.probe('api/src')
    expect(r).toEqual({ ok: true, root: 'api/src', repoRoot: 'api', current: 'main' })
  })

  it('a detached HEAD reports current: null', async () => {
    const r = await make({}, { [at('api')]: { top: at('api'), current: null } }).store.probe('api')
    expect(r).toMatchObject({ ok: true, repoRoot: 'api', current: null })
  })

  it('a folder whose repo lies OUTSIDE the project gets no git modes', async () => {
    const parent = dirname(PROJECT)
    const r = await make({}, { [PROJECT]: { top: parent } }).store.probe('docs')
    expect(r).toMatchObject({ ok: true, root: 'docs' })
    if (r.ok) {
      expect(r.repoRoot).toBeUndefined()
      expect(r.gitReason).toContain('outside the project')
    }
  })
})

describe('create', () => {
  it('folder-as-is: no allocation, the root itself is the cwd', async () => {
    const { store, deps } = make()
    const r = await store.create({ name: 'Docs', root: 'docs', mode: 'folder' })
    expect(r).toEqual({ ok: true, id: 'ws-id-1', root: 'docs', cwd: at('docs') })
    expect(deps.worktrees.allocate).not.toHaveBeenCalled()
  })

  it('worktree: allocates ws/<slug> off the chosen base from the OWNING repo, then stat-proves', async () => {
    const { store, deps } = make()
    dirs.add(at('.canvas', 'worktrees', 'ws-api'))
    const r = await store.create({ name: 'API', root: 'api', mode: 'worktree', base: 'release' })
    expect(deps.worktrees.allocate).toHaveBeenCalledWith({
      repoDir: at('api'),
      slug: 'ws-api',
      branch: 'ws/api',
      base: 'release'
    })
    expect(r).toEqual({
      ok: true,
      id: 'ws-id-1',
      root: 'api',
      cwd: at('.canvas', 'worktrees', 'ws-api'),
      worktree: {
        repoRoot: 'api',
        worktree: '.canvas/worktrees/ws-api',
        branch: 'ws/api',
        baseRef: 'release',
        base: 'abc123'
      }
    })
  })

  it('worktree on a monorepo subfolder: the cwd is that folder INSIDE the worktree', async () => {
    const { store } = make()
    dirs.add(at('.canvas', 'worktrees', 'ws-web'))
    dirs.add(at('.canvas', 'worktrees', 'ws-web', 'src'))
    const r = await store.create({ name: 'Web', root: 'api/src', mode: 'worktree', base: 'main' })
    expect(r).toMatchObject({ ok: true, cwd: at('.canvas', 'worktrees', 'ws-web', 'src') })
  })

  it('an effective root missing from the fresh worktree is refused and the tree is taken back', async () => {
    const { store, deps } = make()
    dirs.add(at('.canvas', 'worktrees', 'ws-web')) // …but no `src` inside it (untracked)
    const r = await store.create({ name: 'Web', root: 'api/src', mode: 'worktree', base: 'main' })
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('not committed') })
    expect(deps.worktrees.removeIfClean).toHaveBeenCalledWith(at('.canvas', 'worktrees', 'ws-web'))
  })

  it('attach: checks out the named branch; baseRef is that branch', async () => {
    const { store, deps } = make()
    dirs.add(at('.canvas', 'worktrees', 'ws-login'))
    const r = await store.create({
      name: 'Login',
      root: 'api',
      mode: 'attach',
      branch: 'feature/login'
    })
    expect(deps.worktrees.allocate).toHaveBeenCalledWith({
      repoDir: at('api'),
      slug: 'ws-login',
      branch: 'feature/login',
      attach: true
    })
    expect(r).toMatchObject({
      ok: true,
      worktree: { branch: 'feature/login', baseRef: 'feature/login' }
    })
  })

  it('a git mode on a non-repo folder is refused before any allocation', async () => {
    const { store, deps } = make()
    const r = await store.create({ name: 'Docs', root: 'docs', mode: 'worktree', base: 'main' })
    expect(r).toEqual({ ok: false, reason: NOT_A_REPO })
    expect(deps.worktrees.allocate).not.toHaveBeenCalled()
  })

  it("the allocator's refusal reaches the human verbatim", async () => {
    const worktrees = fakeWorktrees({
      allocate: vi.fn(async () => ({
        ok: false as const,
        reason: "git worktree add failed — 'x' is already checked out"
      }))
    })
    const r = await make({ worktrees }).store.create({
      name: 'L',
      root: 'api',
      mode: 'attach',
      branch: 'x'
    })
    expect(r).toEqual({ ok: false, reason: "git worktree add failed — 'x' is already checked out" })
  })

  it('refuses a blank name and an unknown mode', async () => {
    const { store } = make()
    expect(await store.create({ name: '  ', root: 'api', mode: 'folder' })).toMatchObject({
      ok: false
    })
    expect(await store.create({ name: 'A', root: 'api', mode: 'bogus' as never })).toEqual({
      ok: false,
      reason: 'Unknown git mode.'
    })
  })
})

describe('status + delete', () => {
  const folderWs: WorkspaceMirror = { id: 'f', name: 'Docs', goal: '', color: 'blue', root: 'docs' }
  const wtWs: WorkspaceMirror = {
    id: 'w',
    name: 'API',
    goal: '',
    color: 'violet',
    root: 'api',
    worktrees: [
      {
        repoRoot: 'api',
        worktree: '.canvas/worktrees/ws-api',
        branch: 'ws/api',
        baseRef: 'release',
        base: 'abc'
      }
    ]
  }
  const wtAbs = at('.canvas', 'worktrees', 'ws-api')
  const lookup = (id: string): WorkspaceMirror | undefined =>
    [folderWs, wtWs].find((w) => w.id === id)

  it('an unknown id says so (the renderer retries while MAIN mirror catches up)', async () => {
    expect(await make().store.status('zzz')).toEqual({ ok: false, reason: 'unknown-workspace' })
  })

  it('status lists live terminals spawned INSIDE the worktree — separators/case ignored', async () => {
    const { store } = make({
      getWorkspace: lookup,
      liveTerminals: () => [
        { id: 't-in', cwd: wtAbs.toUpperCase() },
        { id: 't-out', cwd: at('api') }
      ]
    })
    const r = await store.status('w')
    expect(r).toEqual({
      ok: true,
      kind: 'worktree',
      exists: true,
      dirty: false,
      changed: 0,
      running: process.platform === 'win32' ? ['t-in'] : []
    })
  })

  it('folder-as-is delete only drops the record — nothing on disk is touched', async () => {
    const { store, deps } = make({ getWorkspace: lookup })
    expect(await store.remove({ id: 'f' })).toEqual({ ok: true, outcome: 'record' })
    expect(deps.worktrees.removeIfClean).not.toHaveBeenCalled()
    expect(deps.worktrees.dispose).not.toHaveBeenCalled()
  })

  it('live terminals inside the worktree block the delete', async () => {
    const { store, deps } = make({
      getWorkspace: lookup,
      liveTerminals: () => [{ id: 't1', cwd: wtAbs }]
    })
    const r = await store.remove({ id: 'w' })
    expect(r).toMatchObject({ ok: false, running: ['t1'] })
    expect(deps.worktrees.removeIfClean).not.toHaveBeenCalled()
  })

  it('clean ⇒ git worktree remove through the allocator; the branch survives', async () => {
    const { store, deps } = make({ getWorkspace: lookup })
    const r = await store.remove({ id: 'w' })
    expect(r).toEqual({
      ok: true,
      outcome: 'removed',
      detail: 'worktree removed, branch ws/api kept'
    })
    expect(deps.worktrees.removeIfClean).toHaveBeenCalledWith(wtAbs)
  })

  it('dirty with no choice ⇒ asks (no git write)', async () => {
    const worktrees = fakeWorktrees({
      status: vi.fn(async () => ({ exists: true, dirty: true, changed: 7 }))
    })
    const r = await make({ getWorkspace: lookup, worktrees }).store.remove({ id: 'w' })
    expect(r).toMatchObject({ ok: false, dirty: 7 })
    expect(worktrees.removeIfClean).not.toHaveBeenCalled()
    expect(worktrees.dispose).not.toHaveBeenCalled()
  })

  it('dirty + Keep ⇒ archived, nothing ran', async () => {
    const worktrees = fakeWorktrees({
      status: vi.fn(async () => ({ exists: true, dirty: true, changed: 7 }))
    })
    const r = await make({ getWorkspace: lookup, worktrees }).store.remove({
      id: 'w',
      disposition: 'keep'
    })
    expect(r).toMatchObject({ ok: true, outcome: 'archived' })
    expect(worktrees.dispose).not.toHaveBeenCalled()
  })

  it('dirty + Commit ⇒ the allocator disposes, and a gone tree reads as removed', async () => {
    let calls = 0
    const worktrees = fakeWorktrees({
      status: vi.fn(async () =>
        calls++ === 0
          ? { exists: true, dirty: true, changed: 2 }
          : { exists: false, dirty: false, changed: 0 }
      )
    })
    const r = await make({ getWorkspace: lookup, worktrees }).store.remove({
      id: 'w',
      disposition: 'commit'
    })
    expect(worktrees.dispose).toHaveBeenCalledWith(wtAbs, 'commit', 'API')
    expect(r).toEqual({ ok: true, outcome: 'removed', detail: 'done' })
  })

  it('an off-vocabulary choice is refused, never mapped to a destructive branch', async () => {
    const worktrees = fakeWorktrees({
      status: vi.fn(async () => ({ exists: true, dirty: true, changed: 1 }))
    })
    const r = await make({ getWorkspace: lookup, worktrees }).store.remove({
      id: 'w',
      disposition: 'nuke' as never
    })
    expect(r).toEqual({ ok: false, reason: 'Unknown choice.' })
    expect(worktrees.dispose).not.toHaveBeenCalled()
  })

  it('a worktree already gone from disk ⇒ outcome gone', async () => {
    const worktrees = fakeWorktrees({
      status: vi.fn(async () => ({ exists: false, dirty: false, changed: 0 }))
    })
    expect(await make({ getWorkspace: lookup, worktrees }).store.remove({ id: 'w' })).toEqual({
      ok: true,
      outcome: 'gone'
    })
  })

  it('a record naming a tree Expanse never allocated is dropped without touching disk', async () => {
    const stray: WorkspaceMirror = {
      ...wtWs,
      worktrees: [{ ...wtWs.worktrees![0], worktree: 'elsewhere/tree' }]
    }
    const { store, deps } = make({ getWorkspace: () => stray })
    const r = await store.remove({ id: 'w' })
    expect(r).toMatchObject({ ok: true, outcome: 'record' })
    expect(deps.worktrees.status).not.toHaveBeenCalled()
  })

  it('dirsExist reports each project-relative folder; an escaping path is false', () => {
    const { store } = make()
    expect(store.dirsExist(['api', 'gone', '../x', '.'])).toEqual([true, false, false, true])
  })
})

describe('dependency prompt (O-9): one fixed prompt, single-use, no install run', () => {
  async function armed(over: Partial<WorkspaceStoreDeps> = {}) {
    const ctx = make(over)
    dirs.add(at('.canvas', 'worktrees', 'ws-api'))
    const r = await ctx.store.create({
      name: 'API',
      root: 'api',
      mode: 'worktree',
      base: 'main',
      deps: true
    })
    expect(r.ok).toBe(true)
    return ctx
  }

  it('the prompt is the design text, one line', () => {
    expect(DEPS_PROMPT).toMatch(
      /^This is a fresh git worktree, so its dependencies are not installed\./
    )
    expect(DEPS_PROMPT).not.toMatch(/[\r\n]/)
  })

  it('unarmed (box unticked) ⇒ refused, nothing sent', async () => {
    const { store, deps } = make({ terminalCwd: () => at('.canvas', 'worktrees', 'ws-api') })
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: false })
    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  it('armed ⇒ exactly one prompt to the starter terminal; a second attempt is refused', async () => {
    const { store, deps } = await armed({ terminalCwd: () => at('.canvas', 'worktrees', 'ws-api') })
    expect(await store.depsPrompt('ws-id-1', 't1')).toEqual({ ok: true, delivery: 'ready' })
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: false })
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    expect(deps.sendPrompt).toHaveBeenCalledWith('t1', DEPS_PROMPT)
  })

  it('waits for the starter terminal session to exist', async () => {
    let n = 0
    const { store, deps } = await armed({
      terminalCwd: () => (++n < 4 ? undefined : at('.canvas', 'worktrees', 'ws-api'))
    })
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: true })
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('a terminal outside the new workspace is refused', async () => {
    const { store, deps } = await armed({ terminalCwd: () => at('api') })
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: false })
    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  it('an expired arm is refused', async () => {
    let t = 1000
    const { store, deps } = await armed({
      now: () => t,
      terminalCwd: () => at('.canvas', 'worktrees', 'ws-api')
    })
    t += 31 * 60_000
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: false })
    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  // Dev-check finding (2026-11-03): in a fresh worktree Claude Code first asks "trust this
  // folder?", and the prompt's Enter answered it with the default — "No, exit". The prompt is now
  // HELD (still armed) while that question is the live screen; the human sends it after answering.
  it('the trust question on screen ⇒ HELD, nothing written, arm kept; sent once it is answered', async () => {
    let tail = TRUST_LIVE
    const { store, deps } = await armed({
      terminalCwd: () => at('.canvas', 'worktrees', 'ws-api'),
      screenTail: () => tail
    })
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: false, hold: 'trust-gate' })
    // Even the human's "send now" never writes into the live question.
    expect(await store.depsPrompt('ws-id-1', 't1', { now: true })).toMatchObject({
      hold: 'trust-gate'
    })
    expect(deps.sendPrompt).not.toHaveBeenCalled()
    tail = TRUST_YES
    expect(await store.depsPrompt('ws-id-1', 't1', { now: true })).toEqual({
      ok: true,
      delivery: 'ready'
    })
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('an agent that never settled ⇒ HELD (not-ready); a human "send now" goes through', async () => {
    const { store, deps } = await armed({
      terminalCwd: () => at('.canvas', 'worktrees', 'ws-api'),
      awaitReady: async () => 'unconfirmed'
    })
    expect(await store.depsPrompt('ws-id-1', 't1')).toMatchObject({ ok: false, hold: 'not-ready' })
    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(await store.depsPrompt('ws-id-1', 't1', { now: true })).toMatchObject({ ok: true })
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('a second ask while the first is still waiting is refused (never two prompts)', async () => {
    let release: (v: string) => void = () => undefined
    const ready = new Promise<string>((r) => (release = r))
    const { store, deps } = await armed({
      terminalCwd: () => at('.canvas', 'worktrees', 'ws-api'),
      awaitReady: () => ready
    })
    const first = store.depsPrompt('ws-id-1', 't1')
    expect(await store.depsPrompt('ws-id-1', 't1', { now: true })).toMatchObject({ ok: false })
    release('ready')
    expect(await first).toMatchObject({ ok: true })
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })
})

// Claude Code's first-run question as the ANSI-stripped PTY tail shows it (dev-check screenshot).
const NL = '\r\n'
const TRUST_LIVE = [
  ' Do you trust the files in this folder?',
  '',
  ' Is this a project you created or one you trust? (Like your own code, a well-known open',
  ' source project, or work from your team). If not, take a moment to review what is in this',
  ' folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
  '  '
].join(NL)
const TRUST_NO = [TRUST_LIVE, 'PS C:/work/my project/.canvas/worktrees/ws-api> '].join(NL)
const TRUST_YES = [
  TRUST_LIVE,
  '╭───────────────────────────╮',
  '│ ✻ Welcome to Claude Code! │',
  '╰───────────────────────────╯',
  '> ',
  '  ? for shortcuts'
].join(NL)

describe('trustGateShowing', () => {
  it('is live while the confirm footer is the last thing on screen', () => {
    expect(trustGateShowing(TRUST_LIVE)).toBe(true)
    // The TUI redraws the question on every arrow key — the LAST copy decides.
    expect(trustGateShowing(TRUST_LIVE + TRUST_LIVE)).toBe(true)
  })
  it('is over once anything is drawn below it — the REPL (Yes) or the shell (No, exit)', () => {
    expect(trustGateShowing(TRUST_YES)).toBe(false)
    expect(trustGateShowing(TRUST_NO)).toBe(false)
  })
  it('ignores an ordinary screen and a bare confirm footer', () => {
    expect(trustGateShowing(['PS C:/x> claude', '> ', '  ? for shortcuts'].join(NL))).toBe(false)
    expect(trustGateShowing(' Enter to confirm · Esc to cancel' + NL)).toBe(false)
  })
})

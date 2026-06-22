import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { boardGitDiff } from './gitDiff'

/**
 * GAP-005: drive `boardGitDiff` against REAL temporary git repos (no mocks), covering the
 * real-git behaviors the mocked unit tests can only assert by shape: a modified file, an
 * untracked file NOW being visible (GAP-001), a deleted file, a binary file, a clean repo →
 * '', and the no-commits-yet fallback.
 *
 * SAFETY — this is the only place the suite touches real git, and the git PATH under test
 * (`boardGitDiff`) is strictly READ-ONLY (diff / ls-files / diff --no-index — never add /
 * commit / checkout / reset). The fixture SETUP below does run `git init/add/commit` to build
 * a throwaway repo, but EVERY invocation is hermetically pinned to that repo via an absolute
 * GIT_DIR/GIT_WORK_TREE (git's directory discovery is bypassed → it can NEVER walk up to the
 * host worktree's repo) and identity is supplied via env (no `git config` write vector). The
 * repo lives under the OS temp root only and is asserted to start there before any git runs.
 * Mirrors e2e/gitDiff.e2e.ts:22-77.
 */

/** Hermetic git for one throwaway repo. */
const gitFor =
  (repo: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_DIR: join(repo, '.git'),
        GIT_WORK_TREE: repo,
        GIT_AUTHOR_NAME: 'itest',
        GIT_AUTHOR_EMAIL: 'itest@example.com',
        GIT_COMMITTER_NAME: 'itest',
        GIT_COMMITTER_EMAIL: 'itest@example.com'
      },
      encoding: 'utf8'
    })

/** Make a fresh throwaway repo under the OS temp root, refusing to run anywhere else. */
function makeRepo(): { repo: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'itest-gitdiff-'))
  if (!repo.startsWith(tmpdir())) {
    throw new Error(`itest-gitdiff: refusing to run outside tmpdir (${repo})`)
  }
  const git = gitFor(repo)
  git('init', '-q')
  return { repo, git }
}

describe('boardGitDiff (integration — real git)', () => {
  const created: string[] = []
  const newRepo = (): { repo: string; git: (...args: string[]) => string } => {
    const r = makeRepo()
    created.push(r.repo)
    return r
  }
  // The injected cwd resolver the orchestrator would supply (board id → resolved spawn cwd).
  const getCwd = (repo: string) => (id: string) => (id === 'board-1' ? repo : undefined)

  afterEach(() => {
    while (created.length) {
      const repo = created.pop()
      if (repo) rmSync(repo, { recursive: true, force: true })
    }
  })

  it('returns "" when the board has no known cwd (never reaches git)', async () => {
    expect(await boardGitDiff('board-1', () => undefined)).toBe('')
  })

  it('returns "" when the cwd is not a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'itest-notrepo-'))
    created.push(dir)
    expect(await boardGitDiff('board-1', () => dir)).toBe('')
  })

  it('shows a modified tracked file in the working-tree diff vs HEAD', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, 'tracked.txt'), 'line one\nline two\nline three\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    writeFileSync(join(repo, 'tracked.txt'), 'line one\nline two CHANGED\nline three\nline four\n')

    const out = await boardGitDiff('board-1', getCwd(repo))
    expect(out).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(out).toContain('line two CHANGED')
    expect(out).toContain('+line four')
  })

  it('makes an untracked (never-staged) file visible as a new-file addition (GAP-001)', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, 'tracked.txt'), 'seed\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    // A brand-new file the agent created but never `git add`-ed: invisible to `git diff HEAD`.
    writeFileSync(join(repo, 'untracked.txt'), 'a brand-new file\nsecond line\n')

    const out = await boardGitDiff('board-1', getCwd(repo))
    expect(out).toContain('untracked.txt')
    expect(out).toContain('new file mode')
    expect(out).toContain('+a brand-new file')
  })

  it('ignores files matched by .gitignore when synthesizing untracked diffs (GAP-001)', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    writeFileSync(join(repo, 'ignored.log'), 'should NOT appear\n')
    writeFileSync(join(repo, 'visible.txt'), 'should appear\n')

    const out = await boardGitDiff('board-1', getCwd(repo))
    expect(out).toContain('visible.txt')
    expect(out).not.toContain('ignored.log')
    expect(out).not.toContain('should NOT appear')
  })

  it('shows a deleted tracked file with a deleted-file marker', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, 'doomed.txt'), 'to be deleted\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    rmSync(join(repo, 'doomed.txt'))

    const out = await boardGitDiff('board-1', getCwd(repo))
    expect(out).toContain('doomed.txt')
    expect(out).toContain('deleted file mode')
  })

  it('renders an untracked binary file as "Binary files … differ" (GAP-001)', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    // NUL bytes → git treats it as binary; the synthesized addition is the "Binary files" line.
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 42]))

    const out = await boardGitDiff('board-1', getCwd(repo))
    expect(out).toContain('blob.bin')
    expect(out).toContain('Binary files')
    expect(out).toContain('differ')
  })

  it('returns "" for a clean repo (committed, no working-tree changes)', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, 'tracked.txt'), 'clean\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')

    expect(await boardGitDiff('board-1', getCwd(repo))).toBe('')
  })

  it('falls back to the unstaged diff when there are no commits yet (HEAD absent)', async () => {
    const { repo, git } = newRepo()
    // A repo with NO commit → `git diff HEAD` errors (bad revision) and boardGitDiff falls back
    // to the unstaged-only `git diff`. To make that fallback produce output we stage a file then
    // modify it on disk, creating a worktree-vs-index delta the fallback reports. (Staging is
    // fixture SETUP; the boardGitDiff path stays read-only.)
    writeFileSync(join(repo, 'staged.txt'), 'first version\n')
    git('add', 'staged.txt')
    writeFileSync(join(repo, 'staged.txt'), 'first version\nsecond line added on disk\n')

    const out = await boardGitDiff('board-1', getCwd(repo))
    // The worktree-vs-index delta surfaces via the no-commits fallback — proving it neither
    // throws on the absent HEAD nor masks the change.
    expect(out).toContain('staged.txt')
    expect(out).toContain('+second line added on disk')
  })

  it('concatenates the untracked diffs AFTER the tracked diff', async () => {
    const { repo, git } = newRepo()
    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo CHANGED\n')
    writeFileSync(join(repo, 'untracked.txt'), 'fresh\n')

    const out = await boardGitDiff('board-1', getCwd(repo))
    const trackedAt = out.indexOf('two CHANGED')
    const untrackedAt = out.indexOf('untracked.txt')
    expect(trackedAt).toBeGreaterThanOrEqual(0)
    expect(untrackedAt).toBeGreaterThanOrEqual(0)
    expect(trackedAt).toBeLessThan(untrackedAt)
  })
})

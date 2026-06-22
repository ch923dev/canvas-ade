import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * @terminal PR-2 read-only gitDiff (app-side), against the REAL running app.
 *
 * `gitDiff` is the swarm orchestrator's read-only working-tree diff: orchestrator.gitDiff
 * (terminal-type check + 100 KB clamp) → registry.gitDiff → boardGitDiff → `simple-git` in
 * MAIN, keyed by the board's resolved spawn cwd (`boardCwds`, populated when the PTY spawns).
 * None of that reproduces in jsdom — it needs a real PTY spawn in a real git repo. The pinned
 * `@expanse-ade/mcp` package (>=0.11.0; app pins ^0.13.0) DOES register a `git_diff` MCP tool
 * that routes to `orchestrator.gitDiff`, but reaching it over the wire needs a minted token +
 * scope (terminal agents aren't auto-connected), so this drives the same app-side path
 * in-process via the CANVAS_E2E `__canvasE2EMain.gitDiff` seam.
 *
 * The base `page` fixture resets the canvas before each test, so boards never leak between them.
 */

// Hermetic git for the throwaway repo. EVERY invocation is pinned to it via an absolute
// GIT_DIR/GIT_WORK_TREE, so git's directory discovery is bypassed entirely and it can NEVER
// walk up to find (and mutate) the HOST worktree's repo. Identity is supplied via env, so the
// test never runs `git config` and therefore has no config-write vector into any repo. (Belt
// and suspenders after a prior run's setup escaped into the host repo + clobbered its identity.)
const gitFor =
  (repo: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_DIR: join(repo, '.git'),
        GIT_WORK_TREE: repo,
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.com',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.com'
      },
      encoding: 'utf8'
    })

/** The seam, tolerant of the two transient states: the renderer→MAIN board mirror not yet
 *  carrying a freshly-seeded board (orchestrator throws "board not found"), and the PTY not
 *  yet spawned (diff is ''). Returns the error MESSAGE string on a (handled) rejection. */
const callGitDiff = async (app: Parameters<typeof mainCall>[0], id: string): Promise<string> => {
  try {
    return await mainCall<string>(app, 'gitDiff', id)
  } catch (e) {
    return String(e)
  }
}

test.describe('@terminal gitDiff (read-only working-tree diff via the app-side seam)', () => {
  let repo: string

  test.beforeAll(() => {
    // A throwaway repo with a real uncommitted diff vs HEAD that exercises every case Lane A's
    // gitDiff now covers: a modified tracked file, an intent-to-added new file (so `git diff
    // HEAD` reports it), a GENUINELY untracked file (never `git add`-ed → only visible via the
    // ls-files + `diff --no-index` synthesis, GAP-001), a DELETED tracked file (GAP-005), and a
    // BINARY file change (GAP-005). All committed bytes are seeded first, then mutated.
    repo = mkdtempSync(join(tmpdir(), 'e2e-gitdiff-'))
    // SAFETY: only ever operate on a throwaway dir under the OS temp root — never the host repo.
    if (!repo.startsWith(tmpdir())) {
      throw new Error(`e2e-gitdiff: refusing to run outside tmpdir (${repo})`)
    }
    const git = gitFor(repo)
    git('init', '-q')
    writeFileSync(join(repo, 'hello.txt'), 'line one\nline two\nline three\n')
    // A tracked file that will be deleted (unstaged rm) — git renders `deleted file mode`.
    writeFileSync(join(repo, 'gone.txt'), 'to be deleted\n')
    // A tracked BINARY file (NUL bytes) that will be changed — git renders `Binary files … differ`.
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]))
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    // Modify the tracked text file.
    writeFileSync(join(repo, 'hello.txt'), 'line one\nline two CHANGED\nline three\nline four\n')
    // Intent-to-added new file (tracked-with-no-content) — `git diff HEAD` reports the addition.
    writeFileSync(join(repo, 'fresh.txt'), 'a brand-new file\n')
    git('add', '-N', 'fresh.txt')
    // Genuinely untracked new file — created, NEVER `git add`-ed (GAP-001). Only the read-only
    // ls-files + `diff --no-index` synthesis surfaces it; plain `git diff HEAD` would omit it.
    writeFileSync(join(repo, 'untracked.txt'), 'never staged at all\n')
    // Delete the tracked file from the working tree (unstaged rm) — `deleted file mode` (GAP-005).
    rmSync(join(repo, 'gone.txt'))
    // Mutate the tracked binary file — `Binary files a/logo.bin and b/logo.bin differ` (GAP-005).
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0x00, 0x10, 0x20, 0x00, 0x0f, 0x0e, 0x7f]))
  })

  test.afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  test('returns the working-tree diff for a terminal board whose cwd is a git repo', async ({
    page,
    electronApp
  }) => {
    test.slow() // real PTY spawn + mirror propagation
    const id = await seed(page, 'terminal', { cwd: repo })
    // Measure the board so its PTY spawns — the spawn is what records the cwd in boardCwds.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    // The diff appears once the mirror carries the board AND the PTY has spawned its cwd.
    await expect
      .poll(() => callGitDiff(electronApp, id), { timeout: 20_000 })
      .toContain('line two CHANGED')
    const diff = await callGitDiff(electronApp, id)
    expect(diff).toContain('line four') // the added line in the modified file
    expect(diff).toContain('fresh.txt') // the intent-to-added new file
    expect(diff).toContain('new file mode')
    // GAP-001: a GENUINELY untracked file (never `git add`-ed) now surfaces via the read-only
    // ls-files + `diff --no-index` synthesis — its name AND a `new file mode` marker both appear.
    expect(diff).toContain('untracked.txt')
    // GAP-005: a deleted tracked file shows the `deleted file mode` marker for `gone.txt`.
    expect(diff).toContain('gone.txt')
    expect(diff).toContain('deleted file mode')
    // GAP-005: a changed binary file renders git's `Binary files … differ` line (chip "+0 −0").
    expect(diff).toContain('logo.bin')
    expect(diff).toContain('Binary files')
  })

  test('SECURITY: rejects a non-terminal board (browser content never implies a repo)', async ({
    page,
    electronApp
  }) => {
    const bid = await seed(page, 'browser')
    // Wait out the mirror lag, then assert the terminal-type rejection (not "board not found").
    await expect
      .poll(() => callGitDiff(electronApp, bid), { timeout: 8_000 })
      .toContain('not a terminal board')
  })

  test('rejects an unknown board id', async ({ electronApp }) => {
    const out = await callGitDiff(electronApp, 'no-such-board-id')
    expect(out).toContain('board not found')
  })
})

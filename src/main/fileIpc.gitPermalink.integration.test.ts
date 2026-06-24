/**
 * REGRESSION (host-repo escape): `file:gitPermalink` must resolve the PROJECT's repo, not an
 * ambient `GIT_DIR`/`GIT_WORK_TREE` (e.g. the env a git `pre-push` hook exports, forwarded into
 * the app by `e2e/fixtures.ts`). Drives the REAL handler over two real temp repos: the project
 * ("board") and a DECOY pointed to by the ambient git env. Without `repoScopedEnv()` the permalink
 * carries the DECOY's owner/repo/sha. Mirrors the boardGitDiff regression in
 * gitDiff.integration.test.ts. See src/main/gitEnv.ts.
 *
 * SAFETY: only ever runs git against throwaway repos under the OS temp root; the handler path is
 * read-only (checkIsRepo / remote get-url / revparse), and the SETUP git commands are hermetically
 * pinned to their own repo via absolute GIT_DIR/GIT_WORK_TREE (discovery bypassed → never walks up
 * to the host repo) with identity supplied via env (no `git config` write vector).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const state = vi.hoisted(() => ({ projectDir: '' }))
vi.mock('./projectStore', async (orig) => ({
  ...(await orig<typeof import('./projectStore')>()),
  getCurrentDir: () => state.projectDir
}))

import { registerFileIpc } from './fileIpc'
import { createIpcCapture, mainWin } from './ipcTestHarness'

type PermalinkResult = { ok: true; url: string } | { ok: false; reason: string }

/** Hermetic git for one throwaway repo (pinned GIT_DIR/GIT_WORK_TREE + env identity). */
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

/** A throwaway repo with a GitHub `origin` and one committed file. */
const mkRepo = (prefix: string, origin: string): string => {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  if (!repo.startsWith(tmpdir())) throw new Error(`refusing to run outside tmpdir (${repo})`)
  const git = gitFor(repo)
  git('init', '-q')
  git('remote', 'add', 'origin', origin)
  writeFileSync(join(repo, 'app.txt'), 'hello\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  return repo
}

describe('file:gitPermalink — repo-scoped env (host-repo escape regression)', () => {
  const dirs: string[] = []
  const savedEnv = { dir: process.env.GIT_DIR, work: process.env.GIT_WORK_TREE }
  afterEach(() => {
    if (savedEnv.dir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = savedEnv.dir
    if (savedEnv.work === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = savedEnv.work
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    state.projectDir = ''
  })

  it('resolves the PROJECT repo even when ambient GIT_DIR/GIT_WORK_TREE point at another repo', async () => {
    const board = mkRepo('gitpermalink-board-', 'https://github.com/board-owner/board-repo.git')
    const decoy = mkRepo('gitpermalink-decoy-', 'https://github.com/decoy-owner/decoy-repo.git')
    dirs.push(board, decoy)
    state.projectDir = board

    // The escape: ambient git vars (as a pre-push hook exports, forwarded into the app).
    process.env.GIT_DIR = join(decoy, '.git')
    process.env.GIT_WORK_TREE = decoy

    const cap = createIpcCapture()
    registerFileIpc(cap.ipcMain, mainWin)
    const res = (await cap.invoke('file:gitPermalink', 'app.txt')) as PermalinkResult

    expect(res.ok).toBe(true)
    if (res.ok) {
      // The board's repo — NOT the decoy the ambient env points at.
      expect(res.url).toContain('github.com/board-owner/board-repo/blob/')
      expect(res.url).toContain('/app.txt')
      expect(res.url).not.toContain('decoy')
    }
  })
})

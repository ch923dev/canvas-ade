/**
 * Swarm worktree allocator (orchestration S3) — the thing that makes parallel WRITERS correct.
 *
 * Before S3 the platform had nothing: no worktrees, no locks, a shared cwd by default, no path
 * claims (A6, all four negatives CONFIRMED), and the app was honest about it by admitting exactly
 * one write-role worker at a time. This module provisions the missing half: a role pack that
 * declares `isolation: 'worktree'` gets **its own git worktree on its own branch, created before
 * its board spawns**, so two builders cannot race on one working tree by construction.
 *
 * 🔒 THE ORDERING CONSTRAINT, which is a trap. `safeCwd` (`ptyShells.ts`) silently redirects a
 * missing directory to `$HOME` (A6-3). Allocate late — or hand over a path we have not PROVEN
 * exists — and the builder writes into the user's home directory with a green status and nothing
 * anywhere saying so. Hence {@link SwarmWorktreeStore.allocate} stats the directory itself and
 * the caller REFUSES the spawn on anything but success.
 *
 * 🔒 The locked rules from `CLAUDE.md` › Git / worktrees bind here verbatim — they were written
 * for the deferred Feature-Workspaces phase and this is the first code to honour them:
 *   - `git init` is **opt-in**: a non-repo project refuses, it is never helpfully initialised,
 *     and NEVER when nested inside a parent repo (we only ever reuse what `--show-toplevel` finds).
 *   - a dirty worktree is **kept on disk + prompted** (commit / stash / discard / keep), never a
 *     silent `--force`.
 *   - always `git worktree remove`, **never `rm -rf`** — this module contains no recursive delete
 *     at all, which is also why it can never follow a junction the way `remove-worktree.ps1`
 *     exists to prevent.
 *   - `simple-git` runs ONLY in MAIN, behind the frame-guarded IPC that already exists.
 *
 * 🔒 Branches are NEVER deleted by Expanse, at any point, including on `discard` — the branch is
 * the human's record of the work, and the merge sequence is built from it.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SimpleGit } from 'simple-git'
import { repoScopedGit } from './gitEnv'
import type { SwarmWorktreeDisposition, SwarmWorktreeStatus } from '../shared/swarmLedgerTypes'

/** Block-timeout for any single git sub-process, matching `gitDiff`'s bound. */
export const WORKTREE_TIMEOUT_MS = 15_000

/** Where worktrees live, relative to the project (design D1 — inside the ADR 0009 boundary). */
export const WORKTREE_SUBDIR = join('.canvas', 'worktrees')

/** Branch namespace. Run-scoped so two runs in one project never collide (design D2). */
export const BRANCH_PREFIX = 'swarm'

/** Suffix attempts before allocation gives up rather than looping on a colliding name. */
const MAX_NAME_ATTEMPTS = 20

/** Bound on a worker name → slug, so a hostile/absurd name cannot become a huge path segment. */
const MAX_SLUG_LEN = 48

export type WorktreeAllocation = { worktree: string; branch: string }

export type AllocateOutcome =
  | ({ ok: true } & WorktreeAllocation)
  /** `reason` is a SENTENCE, shown to the human verbatim — never a bare error code. */
  | { ok: false; reason: string }

export interface SwarmWorktreeStore {
  /**
   * Create a worktree for one worker. Returns the ABSOLUTE path + branch on success. Every
   * failure is a refusal carrying a human-readable reason; there is no partial-success path and
   * no fallback to the shared project tree (that fallback is exactly the bug S3 exists to kill).
   */
  allocate(runId: string, workerName: string): Promise<AllocateOutcome>
  /** Live git facts for one worktree. Never throws — an unreadable tree reads as not-exists. */
  status(worktree: string): Promise<SwarmWorktreeStatus>
  /**
   * `git worktree remove` (no force) when the tree is CLEAN. A dirty tree is left exactly where
   * it is — that is the locked policy, not a failure. The branch always survives.
   */
  removeIfClean(worktree: string): Promise<{ removed: boolean; reason?: string }>
  /**
   * Apply a human-chosen disposition to a DIRTY worktree, then remove it (except for `keep`).
   * Re-checks dirtiness itself: between the row being drawn and the human clicking, the worker
   * may have committed its own work, and running `discard` against a clean tree would destroy
   * nothing it was authorised to destroy but would still remove a tree the human meant to keep.
   */
  dispose(
    worktree: string,
    choice: SwarmWorktreeDisposition,
    label: string
  ): Promise<{ ok: boolean; detail: string }>
  /** Is this path inside the CURRENT project's worktree dir? The guard on every destructive path. */
  owns(worktree: string): boolean
}

export interface SwarmWorktreeDeps {
  /** The ACTIVE project dir, re-read on every call. `null` ⇒ every call refuses. */
  getProjectDir: () => string | null
  /** simple-git seam (tests inject a stub). Default: a repo-scoped, bounded instance. */
  gitFor?: (cwd: string) => SimpleGit
  /** fs seam (tests inject). Default: `node:fs`. */
  exists?: (p: string) => boolean
  isDir?: (p: string) => boolean
}

/**
 * A worker name → a path/branch-safe slug. Anything outside `[a-z0-9-]` collapses to `-`, so a
 * model-authored name can never introduce a path separator, a `..`, or a git refname character
 * (`~ ^ : ? * [ \` and friends are all outside the class). An empty result falls back to `worker`.
 */
export function slugify(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '')
  return slug || 'worker'
}

/**
 * The run's short id — 8 hex-ish chars of the board id, enough to namespace, short enough to read.
 * Deliberately does NOT route through {@link slugify}: that substitutes `worker` for an empty
 * name, which would put `swarm/worker/builder-1` in a branch and read as a second worker name.
 */
export function runSlug(runId: string): string {
  const s = String(runId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 8)
  return s || 'run'
}

/** `swarm/a1b2c3d4/builder-1` (design D2). */
export function branchFor(runId: string, workerSlug: string, attempt = 0): string {
  const base = `${BRANCH_PREFIX}/${runSlug(runId)}/${workerSlug}`
  return attempt === 0 ? base : `${base}-${attempt + 1}`
}

/** `<project>/.canvas/worktrees/<slug>` (design D1). */
export function worktreeDirFor(projectDir: string, workerSlug: string, attempt = 0): string {
  const leaf = attempt === 0 ? workerSlug : `${workerSlug}-${attempt + 1}`
  return join(projectDir, WORKTREE_SUBDIR, leaf)
}

/** The branch's last segment — what the card renders when the full ref will not fit. */
export function branchLeaf(branch: string): string {
  const parts = branch.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : branch
}

/** Normalise for a containment compare that is not fooled by separators or a trailing slash. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** `git status --porcelain` output → changed-entry count (untracked included: `-u` is the default). */
export function countPorcelain(out: string): number {
  return out.split('\n').filter((l) => l.trim().length > 0).length
}

export function createSwarmWorktreeStore(deps: SwarmWorktreeDeps): SwarmWorktreeStore {
  const exists = deps.exists ?? ((p: string): boolean => existsSync(p))
  const isDir =
    deps.isDir ??
    ((p: string): boolean => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
  const gitFor =
    deps.gitFor ??
    ((cwd: string): SimpleGit =>
      // `repoScopedGit` is not optional: a MAIN launched from a git hook inherits GIT_DIR
      // pointing at the HOST repo, and every command below would then operate on the wrong
      // repository — creating a worktree of, and committing into, somebody else's checkout.
      repoScopedGit(cwd, { timeout: { block: WORKTREE_TIMEOUT_MS } }))

  /** The project's worktree root — the containment boundary for every destructive operation. */
  const rootFor = (projectDir: string): string => join(projectDir, WORKTREE_SUBDIR)

  const owns = (worktree: string): boolean => {
    const project = deps.getProjectDir()
    if (!project || !worktree) return false
    const root = normPath(rootFor(project))
    const target = normPath(worktree)
    // Strict containment: the root itself is not a worktree, and a sibling directory whose name
    // merely starts with the root string (`…/worktrees-old`) must not pass.
    return target.length > root.length && target.startsWith(root + '/')
  }

  return {
    async allocate(runId, workerName) {
      const project = deps.getProjectDir()
      if (!project) {
        return {
          ok: false,
          reason:
            'no project is open, so there is nowhere to create a worktree — open a project folder first'
        }
      }
      const slug = slugify(workerName)
      let repoRoot: string
      try {
        const probe = gitFor(project)
        if (!(await probe.checkIsRepo())) {
          return {
            ok: false,
            reason:
              'the project folder is not a git repository — Expanse never runs `git init` for you. Open a git repository as the project, or spawn a read-only role'
          }
        }
        repoRoot = (await probe.revparse(['--show-toplevel'])).trim()
      } catch (err) {
        return { ok: false, reason: `git could not read the project repository — ${errText(err)}` }
      }
      if (!repoRoot) {
        return { ok: false, reason: 'git could not resolve the repository root for this project' }
      }

      // First free (path, branch) pair. Both must be free: a leftover directory from a previous
      // run and a leftover branch are independent conditions, and `worktree add` fails on either.
      const git = gitFor(repoRoot)
      let branches: Set<string>
      try {
        branches = new Set((await git.branchLocal()).all)
      } catch (err) {
        return { ok: false, reason: `git could not list branches — ${errText(err)}` }
      }
      let chosen: WorktreeAllocation | null = null
      for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
        const worktree = worktreeDirFor(project, slug, attempt)
        const branch = branchFor(runId, slug, attempt)
        if (!exists(worktree) && !branches.has(branch)) {
          chosen = { worktree, branch }
          break
        }
      }
      if (!chosen) {
        return {
          ok: false,
          reason: `every worktree name for "${slug}" is already taken (${MAX_NAME_ATTEMPTS} tried) — clean up ${WORKTREE_SUBDIR} or rename the worker`
        }
      }

      try {
        // The one allocate-time git WRITE. Base is the repo's current HEAD, deliberately not
        // `main`: every worker starts from the commit the human was looking at when the run began,
        // and branching off `main` would silently rebase the whole swarm onto a branch they are
        // not on.
        await git.raw(['worktree', 'add', '-b', chosen.branch, chosen.worktree, 'HEAD'])
      } catch (err) {
        return { ok: false, reason: `git worktree add failed — ${errText(err)}` }
      }
      // 🔒 The safeCwd guard. Never hand a path to the spawn path without proving it exists: a
      // missing dir is silently redirected to $HOME, so "git said ok" is not good enough.
      if (!isDir(chosen.worktree)) {
        return {
          ok: false,
          reason: `git reported success but ${chosen.worktree} is not a directory — refusing to spawn (a missing cwd is silently redirected to your home folder)`
        }
      }
      return { ok: true, ...chosen }
    },

    async status(worktree) {
      const absent: SwarmWorktreeStatus = { exists: false, dirty: false, changed: 0 }
      if (!worktree || !isDir(worktree)) return absent
      try {
        const out = await gitFor(worktree).raw(['status', '--porcelain'])
        const changed = countPorcelain(out)
        return { exists: true, dirty: changed > 0, changed }
      } catch {
        // Unreadable is UNKNOWN, and unknown must not read as clean — a clean reading is what
        // authorises removal. Report it as existing-and-dirty so every destructive path declines.
        return { exists: true, dirty: true, changed: 0 }
      }
    },

    async removeIfClean(worktree) {
      if (!owns(worktree)) {
        return { removed: false, reason: 'not a worktree this project allocated' }
      }
      const st = await this.status(worktree)
      if (!st.exists) return { removed: false, reason: 'already gone' }
      if (st.dirty) {
        // The locked policy, not a failure: keep on disk, and let the triage row prompt.
        return { removed: false, reason: 'uncommitted changes — kept on disk' }
      }
      const project = deps.getProjectDir()
      if (!project) return { removed: false, reason: 'no project is open' }
      try {
        // 🔒 Run from the PROJECT, never from inside the worktree being deleted. A git child
        // spawned with its cwd set to that directory holds it open, and Windows refuses to
        // delete a directory that is any process's cwd — `git worktree remove` then fails with
        // "Permission denied" and the tree leaks. Caught by the e2e against a real repo.
        //
        // No `--force`, ever, on this path. git refuses a dirty/locked tree itself, which is a
        // second guard behind the status check above.
        await gitFor(project).raw(['worktree', 'remove', worktree])
        return { removed: true }
      } catch (err) {
        return { removed: false, reason: errText(err) }
      }
    },

    async dispose(worktree, choice, label) {
      if (!owns(worktree)) return { ok: false, detail: 'not a worktree this project allocated' }
      const st = await this.status(worktree)
      if (!st.exists) return { ok: false, detail: 'the worktree is no longer on disk' }
      if (choice === 'keep') {
        return { ok: true, detail: `kept on disk at ${worktree} — nothing ran` }
      }
      // TOCTOU: the worker may have committed between the row being drawn and this click. A
      // no-longer-dirty tree just gets removed; running `discard` on it would remove a tree the
      // human was answering a now-stale question about.
      if (!st.dirty) {
        const r = await this.removeIfClean(worktree)
        return r.removed
          ? { ok: true, detail: 'the worktree was already clean — removed, branch kept' }
          : { ok: false, detail: r.reason ?? 'could not remove the worktree' }
      }
      const git = gitFor(worktree)
      try {
        if (choice === 'commit') {
          await git.raw(['add', '-A'])
          await git.raw(['commit', '-m', `swarm(${label}): preserve uncommitted work`])
        } else if (choice === 'stash') {
          await git.raw(['stash', 'push', '-u', '-m', `swarm(${label}) preserved work`])
        } else {
          // discard — the only destructive branch in this module, reached ONLY through the
          // human's explicitly named choice + its second confirm. Commits already on the branch
          // survive: this resets the working tree, it never touches history and never deletes
          // the branch.
          await git.raw(['checkout', '--', '.'])
          await git.raw(['clean', '-fd'])
        }
      } catch (err) {
        return { ok: false, detail: `${choice} failed — ${errText(err)}` }
      }
      const r = await this.removeIfClean(worktree)
      const done =
        choice === 'commit'
          ? `committed ${st.changed} file${st.changed === 1 ? '' : 's'} onto the branch`
          : choice === 'stash'
            ? `stashed ${st.changed} file${st.changed === 1 ? '' : 's'}`
            : `discarded ${st.changed} uncommitted file${st.changed === 1 ? '' : 's'}`
      return r.removed
        ? { ok: true, detail: `${done}; worktree removed, branch kept` }
        : // The disposition itself landed — say so, and say why the tree is still there, rather
          // than reporting a failure that would imply the work was not preserved.
          {
            ok: true,
            detail: `${done}; the worktree could not be removed (${r.reason ?? 'unknown'})`
          }
    },

    owns
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300)
}

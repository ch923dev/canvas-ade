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
 *
 * Project Workspaces (WS-1) reuse this allocator rather than fork a second one. The repo is no
 * longer assumed to BE the project: a request names a `repoDir` inside the project (a polyrepo's
 * `api/`), a branch, an optional base, or an existing branch to attach. Every worktree — swarm
 * worker or workspace — still lands under the one `.canvas/worktrees/` root that {@link
 * SwarmWorktreeStore.owns} guards; workspaces take the `ws-` slug namespace. The swarm's request
 * ({@link swarmWorkerRequest}) is the S3 shape exactly: the project as the repo, base `HEAD`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { SimpleGit } from 'simple-git'
import { repoScopedGit } from './gitEnv'
import type { SwarmWorktreeDisposition, SwarmWorktreeStatus } from '../shared/swarmLedgerTypes'

/** Block-timeout for any single git sub-process, matching `gitDiff`'s bound. */
export const WORKTREE_TIMEOUT_MS = 15_000

/** Where worktrees live, relative to the project (design D1 — inside the ADR 0009 boundary). */
export const WORKTREE_SUBDIR = join('.canvas', 'worktrees')

/** Branch namespace. Run-scoped so two runs in one project never collide (design D2). */
export const BRANCH_PREFIX = 'swarm'

/** Workspace branch namespace: `ws/<slug>` (Project Workspaces O-10). */
export const WORKSPACE_BRANCH_PREFIX = 'ws'

/** Workspace worktree leaves are `ws-<slug>`, so they never collide with a worker's leaf. */
export const WORKSPACE_SLUG_PREFIX = 'ws-'

/** Suffix attempts before allocation gives up rather than looping on a colliding name. */
const MAX_NAME_ATTEMPTS = 20

/** Bound on a worker name → slug, so a hostile/absurd name cannot become a huge path segment. */
const MAX_SLUG_LEN = 48

/** Bound on the folders {@link SwarmWorktreeStore.listRepos} looks at, so a huge root stays cheap. */
const MAX_REPO_SCAN = 500

/** Bound on a ref name we will put in an argv. git's own limits are looser; ours only need to fit. */
const MAX_REF_LEN = 255

export type WorktreeAllocation = { worktree: string; branch: string }

export type AllocateOutcome =
  | ({ ok: true } & WorktreeAllocation)
  /** `reason` is a SENTENCE, shown to the human verbatim — never a bare error code. */
  | { ok: false; reason: string }

export interface AllocateRequest {
  /**
   * The folder git is probed in — the repo (or a folder inside it) the worktree is cut from. Must
   * be inside the project. Absent ⇒ the project itself, which is the swarm's S3 shape.
   */
  repoDir?: string
  /** The worktree's leaf under `.canvas/worktrees/`. Re-slugified here; collision-suffixed. */
  slug: string
  /**
   * The branch to CREATE (collision-suffixed in step with the leaf) — or, with `attach`, the
   * EXISTING local branch to check out.
   */
  branch: string
  /** What a new branch starts from. Default `HEAD`, the swarm's base. Not allowed with `attach`. */
  base?: string
  /**
   * Check out an existing local branch instead of creating one (`git worktree add <path>
   * <branch>`). git itself refuses a branch already checked out in another worktree; that
   * refusal is surfaced verbatim.
   */
  attach?: boolean
}

/** One git repo {@link SwarmWorktreeStore.listRepos} found: its folder, and its path from the project. */
export interface RepoEntry {
  dir: string
  /** `''` for the project root itself, else the child folder's name. */
  rel: string
}

export type ListBranchesOutcome =
  | {
      ok: true
      /** The checked-out branch, or `null` when HEAD is detached. */
      current: string | null
      /** Local branches: `main`, `release`. */
      local: string[]
      /** Remote-tracking branches, remote-qualified: `origin/main`. Never fetched — what is on disk. */
      remote: string[]
    }
  | { ok: false; reason: string }

export interface SwarmWorktreeStore {
  /**
   * Create a worktree. Returns the ABSOLUTE path + branch on success. Every failure is a refusal
   * carrying a human-readable reason; there is no partial-success path and no fallback to the
   * shared project tree (that fallback is exactly the bug S3 exists to kill).
   */
  allocate(req: AllocateRequest): Promise<AllocateOutcome>
  /** Live git facts for one worktree. Never throws — an unreadable tree reads as not-exists. */
  status(worktree: string): Promise<SwarmWorktreeStatus>
  /**
   * `git worktree remove` (no force) when the tree is CLEAN, run from the repo that OWNS the
   * worktree. A dirty tree is left exactly where it is — that is the locked policy, not a
   * failure. The branch always survives.
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
  /**
   * The git repos a project holds: the project itself when it is a repo, plus each repo exactly
   * one folder down (a polyrepo). `.canvas/`, `node_modules/`, dot-folders and links are skipped.
   * Read-only; never throws.
   */
  listRepos(projectDir: string): Promise<RepoEntry[]>
  /** A repo's local + remote-tracking branches, as they are on disk. Never fetches. */
  listBranches(repoDir: string): Promise<ListBranchesOutcome>
}

export interface SwarmWorktreeDeps {
  /** The ACTIVE project dir, re-read on every call. `null` ⇒ every call refuses. */
  getProjectDir: () => string | null
  /** simple-git seam (tests inject a stub). Default: a repo-scoped, bounded instance. */
  gitFor?: (cwd: string) => SimpleGit
  /** fs seam (tests inject). Default: `node:fs`. */
  exists?: (p: string) => boolean
  isDir?: (p: string) => boolean
  /** The names of a folder's real sub-directories — links and junctions excluded. */
  listDirs?: (p: string) => string[]
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

/** Attempt 0 is the name itself; attempt n is `<name>-<n+1>`, so the first retry reads `-2`. */
function suffixed(name: string, attempt: number): string {
  return attempt === 0 ? name : `${name}-${attempt + 1}`
}

/** `swarm/a1b2c3d4/builder-1` (design D2). */
export function branchFor(runId: string, workerSlug: string, attempt = 0): string {
  return suffixed(`${BRANCH_PREFIX}/${runSlug(runId)}/${workerSlug}`, attempt)
}

/** `<project>/.canvas/worktrees/<slug>` (design D1). */
export function worktreeDirFor(projectDir: string, workerSlug: string, attempt = 0): string {
  return join(projectDir, WORKTREE_SUBDIR, suffixed(workerSlug, attempt))
}

/** The swarm's request for one worker: the project as the repo, base `HEAD` — S3 unchanged. */
export function swarmWorkerRequest(runId: string, workerName: string): AllocateRequest {
  const slug = slugify(workerName)
  return { slug, branch: branchFor(runId, slug) }
}

/** A workspace name → its worktree leaf, `ws-api`. Capped like any slug. */
export function workspaceSlug(name: string): string {
  return slugify(`${WORKSPACE_SLUG_PREFIX}${slugify(name)}`)
}

/** A workspace name → its new branch, `ws/api` (O-10). */
export function workspaceBranchFor(name: string): string {
  return `${WORKSPACE_BRANCH_PREFIX}/${slugify(name)}`
}

/**
 * Can this ref name go into a git argv? Every argv here is an array (no shell), so the one
 * injection left is a leading `-`: a base of `--force` would be parsed as an option. Whitespace
 * and control characters are refused too; anything else that is not a valid refname is left
 * for git to refuse in its own words.
 */
export function isArgvSafeRef(ref: string): boolean {
  return (
    typeof ref === 'string' &&
    ref.length > 0 &&
    ref.length <= MAX_REF_LEN &&
    !ref.startsWith('-') &&
    // eslint-disable-next-line no-control-regex
    !/[\s\x00-\x1f\x7f]/.test(ref)
  )
}

/**
 * `git for-each-ref --format=%(refname)` output → local and remote-tracking branch names. A
 * remote's symbolic `HEAD` (`refs/remotes/origin/HEAD`) is not a branch and is dropped.
 */
export function parseBranchRefs(out: string): { local: string[]; remote: string[] } {
  const local: string[] = []
  const remote: string[] = []
  for (const line of out.split('\n')) {
    const ref = line.trim()
    if (ref.startsWith('refs/heads/')) {
      local.push(ref.slice('refs/heads/'.length))
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length)
      if (!name.endsWith('/HEAD')) remote.push(name)
    }
  }
  return { local, remote }
}

/** The main worktree's path from `git worktree list --porcelain` — git always lists it first. */
export function mainWorktreeFrom(porcelain: string): string | null {
  const first = porcelain.split('\n').find((l) => l.startsWith('worktree '))
  return first ? first.slice('worktree '.length).trim() || null : null
}

/** The branch's last segment — what the card renders when the full ref will not fit. */
export function branchLeaf(branch: string): string {
  const parts = branch.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : branch
}

/**
 * Normalise for a containment compare that is not fooled by separators, a trailing slash, or a
 * `..` segment (`…/worktrees/../../x` must not pass as under `worktrees/`). POSIX-normalised after
 * the separator swap, so it collapses the same way on every OS.
 */
function normPath(p: string): string {
  return posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '')
}

/** Is `target` the folder `root` or strictly inside it? */
function isWithinOrSame(root: string, target: string): boolean {
  const r = normPath(root)
  const t = normPath(target)
  return t === r || t.startsWith(r + '/')
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
  const listDirs =
    deps.listDirs ??
    ((p: string): string[] => {
      try {
        // `withFileTypes` reports a link as a link, not as its target — so a junction pointing
        // outside the project is never offered as one of its repos.
        return readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch {
        return []
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

  /** `git rev-parse --show-prefix` is empty exactly when `dir` is the top of its worktree. */
  const isRepoTop = async (dir: string): Promise<boolean> => {
    try {
      return (await gitFor(dir).revparse(['--show-prefix'])).trim() === ''
    } catch {
      return false
    }
  }

  return {
    async allocate(req) {
      const project = deps.getProjectDir()
      if (!project) {
        return {
          ok: false,
          reason:
            'no project is open, so there is nowhere to create a worktree — open a project folder first'
        }
      }
      const repoDir = req.repoDir ?? project
      const isProject = normPath(repoDir) === normPath(project)
      if (!isWithinOrSame(project, repoDir)) {
        // O-7: a workspace root outside the project is refused in v1, and so is its repo.
        return {
          ok: false,
          reason: `${repoDir} is outside the open project — a worktree can only be cut from a repository inside it`
        }
      }
      const attach = req.attach === true
      if (attach && req.base !== undefined) {
        return {
          ok: false,
          reason: 'a base only applies to a new branch — attaching checks out the branch as it is'
        }
      }
      const base = req.base ?? 'HEAD'
      for (const ref of [req.branch, base]) {
        if (!isArgvSafeRef(ref)) {
          return { ok: false, reason: `"${ref}" is not a usable branch name` }
        }
      }
      const slug = slugify(req.slug)
      let repoRoot: string
      try {
        // Probe the REPO, not the project: in a polyrepo the project folder holds repos without
        // being one. `--show-toplevel` only ever REUSES the repo git finds (never `git init`).
        const probe = gitFor(repoDir)
        if (!(await probe.checkIsRepo())) {
          return {
            ok: false,
            reason: isProject
              ? 'the project folder is not a git repository — Expanse never runs `git init` for you. Open a git repository as the project, or spawn a read-only role'
              : `${repoDir} is not a git repository — Expanse never runs \`git init\` for you`
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
      // Attach mode suffixes the path only — the branch is the one the human picked.
      const git = gitFor(repoRoot)
      let branches: Set<string>
      try {
        branches = new Set((await git.branchLocal()).all)
      } catch (err) {
        return { ok: false, reason: `git could not list branches — ${errText(err)}` }
      }
      if (attach && !branches.has(req.branch)) {
        // Not passed through to git: `worktree add <path> origin/x` would quietly check out a
        // DETACHED head, and a workspace on no branch has nowhere to keep its commits.
        return {
          ok: false,
          reason: `there is no local branch "${req.branch}" to attach — to work from a remote branch, create a new branch based on it`
        }
      }
      let chosen: WorktreeAllocation | null = null
      for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
        const worktree = worktreeDirFor(project, slug, attempt)
        const branch = attach ? req.branch : suffixed(req.branch, attempt)
        if (!exists(worktree) && (attach || !branches.has(branch))) {
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
        // The one allocate-time git WRITE. The swarm's base is the repo's current HEAD,
        // deliberately not `main`: every worker starts from the commit the human was looking at
        // when the run began, and branching off `main` would silently rebase the whole swarm onto
        // a branch they are not on. A workspace names its base (O-10: e.g. `release`).
        //
        // Attach: git refuses a branch already checked out in another worktree — that refusal is
        // the guard, and its message reaches the human through the catch below.
        await git.raw(
          attach
            ? ['worktree', 'add', chosen.worktree, chosen.branch]
            : ['worktree', 'add', '-b', chosen.branch, chosen.worktree, base]
        )
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
      // The repo that OWNS the tree — the project in the swarm's case, a sub-repo in a polyrepo,
      // where the project folder is not a repo and a removal run from it could only fail. Read
      // from the worktree itself (git lists the main worktree first), so no caller can name the
      // wrong repo. This read finishes before the removal starts, so it holds no cwd open.
      let repoRoot: string | null
      try {
        repoRoot = mainWorktreeFrom(await gitFor(worktree).raw(['worktree', 'list', '--porcelain']))
      } catch (err) {
        return {
          removed: false,
          reason: `could not find the repository that owns it — ${errText(err)}`
        }
      }
      if (!repoRoot) {
        return { removed: false, reason: 'could not find the repository that owns it' }
      }
      try {
        // 🔒 Run from the OWNING REPO, never from inside the worktree being deleted. A git child
        // spawned with its cwd set to that directory holds it open, and Windows refuses to
        // delete a directory that is any process's cwd — `git worktree remove` then fails with
        // "Permission denied" and the tree leaks. Caught by the e2e against a real repo.
        //
        // No `--force`, ever, on this path. git refuses a dirty/locked tree itself, which is a
        // second guard behind the status check above.
        await gitFor(repoRoot).raw(['worktree', 'remove', worktree])
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

    owns,

    async listRepos(projectDir) {
      const found: RepoEntry[] = []
      if (!projectDir) return found
      try {
        if (await gitFor(projectDir).checkIsRepo()) found.push({ dir: projectDir, rel: '' })
      } catch {
        /* unreadable reads as not-a-repo; the children are still worth a look */
      }
      const children = listDirs(projectDir)
        .filter((name) => !name.startsWith('.') && name !== 'node_modules')
        .sort()
        .slice(0, MAX_REPO_SCAN)
      for (const name of children) {
        const dir = join(projectDir, name)
        // A `.git` entry (a dir, or the gitfile of a worktree/submodule) marks a repo's top, and
        // checking for it first spares a git spawn per ordinary folder. `--show-prefix` then
        // confirms it: a stray or broken `.git` is not a repo.
        if (exists(join(dir, '.git')) && (await isRepoTop(dir))) found.push({ dir, rel: name })
      }
      return found
    },

    async listBranches(repoDir) {
      const project = deps.getProjectDir()
      if (!project) return { ok: false, reason: 'no project is open' }
      if (!repoDir || !isWithinOrSame(project, repoDir)) {
        return { ok: false, reason: `${repoDir} is outside the open project` }
      }
      try {
        const git = gitFor(repoDir)
        if (!(await git.checkIsRepo())) {
          return { ok: false, reason: `${repoDir} is not a git repository` }
        }
        // Read only what is already on disk: listing must never reach the network, and a
        // fresher `origin/release` is the human's fetch to run.
        const { local, remote } = parseBranchRefs(
          await git.raw(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
        )
        let current: string | null = null
        try {
          current = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null
        } catch {
          current = null // detached HEAD: `symbolic-ref --quiet` exits 1
        }
        return { ok: true, current, local, remote }
      } catch (err) {
        return { ok: false, reason: `git could not list branches — ${errText(err)}` }
      }
    }
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300)
}

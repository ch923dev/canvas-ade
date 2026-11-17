/**
 * Project Workspaces WS-4 — the MAIN-side lifecycle: probe a folder, create a workspace (folder
 * as-is, or a worktree + branch), read what deleting it would meet, delete it, and spend the
 * one-shot "install dependencies" prompt. Design: docs/research/2026-11-02-project-workspaces
 * §4.3; the IPC face is `workspaceIpc.ts`.
 *
 * 🔒 There is ONE worktree allocator — `swarmWorktree.ts` — and this module only CALLS it
 * (allocate / status / removeIfClean / dispose / owns / listRepos / listBranches). Every locked
 * git rule therefore holds here by construction:
 *   - never `git init` — a folder that is not in a repo only ever gets the folder-as-is mode;
 *   - never `--force`, never `rm -rf` — removal is `git worktree remove` through the allocator,
 *     and a dirty tree is kept on disk until the human picks Commit / Stash / Discard / Keep;
 *   - never delete a branch — nothing here can;
 *   - `simple-git` runs in MAIN only, behind the frame-guarded `workspace:*` IPC.
 *
 * 🔒 ALLOCATE → STAT-PROVE → ONLY THEN RETURN. A create hands the renderer a record (and the
 * starter terminal's cwd) only after the allocator has stat-proven the worktree AND this module has
 * stat-proven the effective root inside it. A missing cwd is silently redirected to `$HOME` by the
 * project-level spawn path, so "git said ok" is never good enough (the S3 trap).
 *
 * 🔒 Expanse never runs an install command (O-9). The dependency step is ONE fixed prompt handed
 * to the starter agent through the shared PTY write gate; the user's tick is the consent, and it
 * is single-use: `create` arms it, `depsPrompt` spends it.
 *
 * Paths: the contract is project-relative POSIX. Containment is checked on REAL paths
 * (`realResolveWithinRoot`, so a junction cannot smuggle a root out of the project — O-7), while
 * every path handed to the allocator is built from the project dir as MAIN knows it, because the
 * allocator's own `owns()` guard compares lexically against that same string.
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { realpath as fsRealpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SimpleGit } from 'simple-git'
import { repoScopedGit } from './gitEnv'
import { realResolveWithinRoot } from './pathSafe'
import {
  WORKTREE_TIMEOUT_MS,
  workspaceBranchFor,
  workspaceSlug,
  type SwarmWorktreeStore
} from './swarmWorktree'
import type { WorkspaceMirror } from './workspaceMirror'
import { sanitizeGroupName } from '../shared/groupName'
import { normalizeWorkspaceRoot } from '../shared/workspaceRules'
import {
  WORKSPACE_DISPOSITIONS,
  type WorkspaceBranchesResult,
  type WorkspaceCreateRequest,
  type WorkspaceCreateResult,
  type WorkspaceDeleteRequest,
  type WorkspaceDeleteResult,
  type WorkspaceDepsPromptResult,
  type WorkspaceProbeResult,
  type WorkspaceRepo,
  type WorkspaceStatusResult
} from '../shared/workspaceIpcTypes'

/** The one fixed dependency prompt (design §4.3 step 5, O-9) — verbatim, one line. */
export const DEPS_PROMPT =
  'This is a fresh git worktree, so its dependencies are not installed. Install them first. Read the lockfiles and manifests to pick the tool (pnpm, npm, pip, poetry, cargo, …), then report what you ran.'

/** The dependency-prompt arm lives this long after create — long enough for an agent to boot and
 *  for the human to answer its first-run trust question before sending a held prompt. */
export const DEPS_ARM_TTL_MS = 30 * 60_000

/** The readiness outcomes that let the prompt go out on its own (no human "Send"). */
const SETTLED = new Set(['ready', 'ready_latched', 'ready_assumed'])

/**
 * Whether an agent's first-run folder-trust question is the LIVE screen (Claude Code: "Yes, I trust
 * this folder" / "No, exit" … "Enter to confirm"). Writing the prompt there would hand the gate an
 * Enter — whose default is "No, exit". `tail` is the ANSI-stripped PTY tail; the question counts as
 * live only while nothing but whitespace follows its confirm footer (after the human answers,
 * the REPL — or, on "No", the shell prompt — is drawn below it).
 */
export function trustGateShowing(tail: string): boolean {
  const end = tail.slice(-2000)
  if (!/trust\s*(this|the\s*files\s*in\s*this)\s*folder|do\s*you\s*trust/i.test(end)) return false
  // The LAST confirm footer is the live one (the TUI redraws the whole question on every key).
  let at = -1
  for (const m of end.matchAll(/enter\s*to\s*confirm/gi)) at = m.index
  if (at === -1) return false
  const after = end.slice(at).split('\n').slice(1).join('\n')
  return after.replace(/\s+/g, '').length === 0
}

/** How long `depsPrompt` waits for the starter terminal's PTY session to exist. */
export const DEPS_SESSION_WAIT_MS = 30_000
const DEPS_SESSION_POLL_MS = 250

/** The locked "never init" sentence — the dialog shows it verbatim on a non-repo folder. */
export const NOT_A_REPO = 'Not a git repository — Expanse never runs `git init`.'

const OUTSIDE =
  "That folder is outside this project. In this version a workspace's folder must be inside the project."

/** One live terminal and the cwd it was spawned in (`pty.getTerminalCwd`). */
export interface WorkspaceTerminal {
  id: string
  cwd: string
}

export interface WorkspaceStoreDeps {
  /** The ACTIVE project dir, re-read on every call. `null` ⇒ every call refuses. */
  getProjectDir: () => string | null
  /** The one allocator (`createSwarmWorktreeStore`). */
  worktrees: SwarmWorktreeStore
  /** MAIN's own workspace mirror (`boardRegistry.listWorkspaces`) — the authority for status /
   *  delete, never a renderer-sent path. */
  getWorkspace: (id: string) => WorkspaceMirror | undefined
  /** Live (spawning / running) terminals with their spawn cwd. */
  liveTerminals: () => WorkspaceTerminal[]
  /** The spawn cwd of one terminal board, or undefined before it has a session. */
  terminalCwd: (boardId: string) => string | undefined
  /** Deliver one prompt through the shared PTY write gate (readiness-gated, audited). */
  sendPrompt: (boardId: string, text: string) => Promise<{ delivery: 'ready' | 'unconfirmed' }>
  /** The shared readiness waiter's outcome for a terminal (the same latch the gate uses). */
  awaitReady: (boardId: string) => Promise<string>
  /** The ANSI-stripped tail of a terminal's output (`pty.readPtyOutput`). Read-only. */
  screenTail: (boardId: string) => string
  gitFor?: (cwd: string) => SimpleGit
  isDir?: (p: string) => boolean
  realpath?: (p: string) => Promise<string>
  /** Physical containment (`pathSafe.realResolveWithinRoot`): the real path of `rel` under the
   *  (real) project, or a throw on any escape — a junction included. */
  resolveWithin?: (rootReal: string, rel: string) => Promise<string>
  newId?: () => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WorkspaceStore {
  probe(root: string): Promise<WorkspaceProbeResult>
  listRepos(): Promise<WorkspaceRepo[]>
  listBranches(repoRoot: string): Promise<WorkspaceBranchesResult>
  create(req: WorkspaceCreateRequest): Promise<WorkspaceCreateResult>
  /** Undo a create whose record the renderer could not write: remove the fresh (clean) worktree. */
  abandon(worktree: string): Promise<{ removed: boolean }>
  status(id: string): Promise<WorkspaceStatusResult>
  remove(req: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResult>
  /** Which of these project-relative folders exist (open-time reconcile). Read-only. */
  dirsExist(paths: string[]): boolean[]
  /** `now`: the human's own "Send" — skips only the settled-agent heuristic, never the trust gate. */
  depsPrompt(
    workspaceId: string,
    boardId: string,
    opts?: { now?: boolean }
  ): Promise<WorkspaceDepsPromptResult>
}

/** Is `target` `root` itself or inside it? Both absolute; win32 compares case-insensitively. */
function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** An absolute path under `base` → canonical project-relative POSIX (`'.'` for `base` itself). */
function toRel(base: string, abs: string): string | null {
  return normalizeWorkspaceRoot(relative(base, abs).split(sep).join('/') || '.')
}

/** A canonical project-relative path → absolute, under the project dir as MAIN knows it. */
function underProject(project: string, rel: string): string {
  return rel === '.' ? project : join(project, ...rel.split('/'))
}

/** `root` relative to `repoRoot` (both canonical, `root` inside `repoRoot`) — `''` when equal. */
function subPath(repoRoot: string, root: string): string {
  if (repoRoot === '.') return root === '.' ? '' : root
  return root === repoRoot ? '' : root.slice(repoRoot.length + 1)
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function createWorkspaceStore(deps: WorkspaceStoreDeps): WorkspaceStore {
  const gitFor =
    deps.gitFor ??
    ((cwd: string): SimpleGit => repoScopedGit(cwd, { timeout: { block: WORKTREE_TIMEOUT_MS } }))
  const isDir =
    deps.isDir ??
    ((p: string): boolean => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
  const realpath = deps.realpath ?? ((p: string): Promise<string> => fsRealpath(p))
  const resolveWithin = deps.resolveWithin ?? realResolveWithinRoot
  const newId = deps.newId ?? ((): string => randomUUID())
  const now = deps.now ?? ((): number => Date.now())
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
  const { worktrees } = deps

  /** O-9 arms: workspace id → the effective root its starter terminal must be spawned in. */
  const depsArms = new Map<string, { cwd: string; at: number; busy: boolean }>()

  const realOrSelf = async (p: string): Promise<string> => {
    try {
      return await realpath(p)
    } catch {
      return p
    }
  }

  /** Board ids of live terminals spawned inside `dir` (the Windows cwd-lock set). */
  const runningInside = async (dir: string): Promise<string[]> => {
    const root = await realOrSelf(dir)
    const out: string[] = []
    for (const t of deps.liveTerminals()) {
      if (isWithinPath(root, await realOrSelf(t.cwd))) out.push(t.id)
    }
    return out
  }

  /** The worktree a workspace record names, absolute — or null for a folder-as-is workspace. */
  const worktreeOf = (project: string, ws: WorkspaceMirror): string | null => {
    const wt = ws.worktrees?.[0]
    return wt ? underProject(project, wt.worktree) : null
  }

  const probe = async (raw: string): Promise<WorkspaceProbeResult> => {
    const project = deps.getProjectDir()
    if (!project) return { ok: false, reason: 'No project is open.' }
    const root = normalizeWorkspaceRoot(raw)
    if (root === null) return { ok: false, reason: OUTSIDE }
    if (root === '.canvas' || root.startsWith('.canvas/')) {
      return { ok: false, reason: "Expanse's own .canvas folder can't be a workspace folder." }
    }
    const projectReal = await realOrSelf(project)
    let abs: string
    try {
      abs = await resolveWithin(projectReal, root)
    } catch {
      return { ok: false, reason: OUTSIDE }
    }
    if (!isDir(abs)) return { ok: false, reason: `${root}/ is not a folder in this project.` }
    let top: string
    try {
      const git = gitFor(abs)
      if (!(await git.checkIsRepo())) return { ok: true, root, gitReason: NOT_A_REPO }
      top = (await git.revparse(['--show-toplevel'])).trim()
    } catch {
      return { ok: true, root, gitReason: NOT_A_REPO }
    }
    const topReal = await realOrSelf(top)
    // Never reached for by a parent repo: a folder whose repo lies OUTSIDE the project can't be
    // branched from here (the worktree's repoRoot must be project-relative, and the locked rule
    // only ever reuses a repo the project holds).
    const repoRoot = isWithinPath(projectReal, topReal) ? toRel(projectReal, topReal) : null
    if (repoRoot === null) {
      return {
        ok: true,
        root,
        gitReason: `This folder's repository (${top}) is outside the project — open that repository as the project to branch from it.`
      }
    }
    let current: string | null = null
    try {
      current = (await gitFor(topReal).raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
      current = current || null
    } catch {
      current = null // detached HEAD
    }
    return { ok: true, root, repoRoot, current }
  }

  return {
    probe,

    async listRepos() {
      const project = deps.getProjectDir()
      if (!project) return []
      const repos = await worktrees.listRepos(project)
      return repos.map((r) => ({ rel: r.rel === '' ? '.' : r.rel }))
    },

    async listBranches(raw) {
      const project = deps.getProjectDir()
      if (!project) return { ok: false, reason: 'No project is open.' }
      const repoRoot = normalizeWorkspaceRoot(raw)
      if (repoRoot === null) return { ok: false, reason: OUTSIDE }
      try {
        await resolveWithin(await realOrSelf(project), repoRoot)
      } catch {
        return { ok: false, reason: OUTSIDE }
      }
      return worktrees.listBranches(underProject(project, repoRoot))
    },

    async create(req) {
      const project = deps.getProjectDir()
      if (!project) return { ok: false, reason: 'No project is open.' }
      const name = sanitizeGroupName(typeof req?.name === 'string' ? req.name : '')
      if (!name) return { ok: false, reason: 'A workspace needs a name.' }
      const mode = req.mode
      if (mode !== 'folder' && mode !== 'worktree' && mode !== 'attach') {
        return { ok: false, reason: 'Unknown git mode.' }
      }
      const p = await probe(req.root)
      if (!p.ok) return p
      const id = newId()
      if (mode === 'folder')
        return { ok: true, id, root: p.root, cwd: underProject(project, p.root) }
      if (!p.repoRoot) return { ok: false, reason: p.gitReason ?? NOT_A_REPO }

      const alloc = await worktrees.allocate(
        mode === 'worktree'
          ? {
              repoDir: underProject(project, p.repoRoot),
              slug: workspaceSlug(name),
              branch: workspaceBranchFor(name),
              base: req.base || 'HEAD'
            }
          : {
              repoDir: underProject(project, p.repoRoot),
              slug: workspaceSlug(name),
              branch: typeof req.branch === 'string' ? req.branch : '',
              attach: true
            }
      )
      if (!alloc.ok) return { ok: false, reason: alloc.reason }

      // A clean, just-made tree: removeIfClean takes it back without touching the branch.
      const undo = async (reason: string): Promise<WorkspaceCreateResult> => {
        await worktrees.removeIfClean(alloc.worktree).catch(() => undefined)
        return { ok: false, reason }
      }
      // 🔒 Stat-prove the EFFECTIVE root too: a folder that is untracked in the repo has no copy in
      // a fresh worktree, and handing its path over would spawn the starter terminal in $HOME.
      const sub = subPath(p.repoRoot, p.root)
      const cwd = sub ? join(alloc.worktree, ...sub.split('/')) : alloc.worktree
      if (!isDir(cwd)) {
        return undo(
          `${p.root}/ is not committed in its repository, so the new worktree has no such folder. Commit it first, or pick the repository's own folder.`
        )
      }
      let base: string
      try {
        base = (await gitFor(alloc.worktree).revparse(['HEAD'])).trim()
      } catch (err) {
        return undo(`git could not read the new worktree's commit — ${errText(err)}`)
      }
      const worktreeRel = toRel(project, alloc.worktree)
      if (!base || worktreeRel === null) return undo('git could not read the new worktree.')
      if (req.deps === true) depsArms.set(id, { cwd, at: now(), busy: false })
      return {
        ok: true,
        id,
        root: p.root,
        cwd,
        worktree: {
          repoRoot: p.repoRoot,
          worktree: worktreeRel,
          branch: alloc.branch,
          baseRef: mode === 'worktree' ? req.base || 'HEAD' : alloc.branch,
          base
        }
      }
    },

    async abandon(raw) {
      const project = deps.getProjectDir()
      const rel = normalizeWorkspaceRoot(raw)
      if (!project || rel === null) return { removed: false }
      const r = await worktrees.removeIfClean(underProject(project, rel))
      return { removed: r.removed }
    },

    async status(id) {
      const project = deps.getProjectDir()
      if (!project) return { ok: false, reason: 'No project is open.' }
      const ws = deps.getWorkspace(id)
      if (!ws) return { ok: false, reason: 'unknown-workspace' }
      const wt = worktreeOf(project, ws)
      if (!wt) {
        const exists = isDir(underProject(project, ws.root))
        return { ok: true, kind: 'folder', exists, dirty: false, changed: 0, running: [] }
      }
      const st = await worktrees.status(wt)
      const running = st.exists ? await runningInside(wt) : []
      return { ok: true, kind: 'worktree', ...st, running }
    },

    async remove(req) {
      const project = deps.getProjectDir()
      if (!project) return { ok: false, reason: 'No project is open.' }
      const ws = deps.getWorkspace(typeof req?.id === 'string' ? req.id : '')
      if (!ws) return { ok: false, reason: 'unknown-workspace' }
      const choice = req.disposition
      // 🔒 Closed vocabulary: an off-set choice is refused, never mapped to a destructive branch.
      if (choice !== undefined && !WORKSPACE_DISPOSITIONS.includes(choice)) {
        return { ok: false, reason: 'Unknown choice.' }
      }
      const wt = worktreeOf(project, ws)
      if (!wt) return { ok: true, outcome: 'record' }
      if (!worktrees.owns(wt)) {
        // A hand-edited record naming a tree Expanse never allocated: drop the record, touch nothing.
        return {
          ok: true,
          outcome: 'record',
          detail: `${ws.worktrees?.[0]?.worktree} is not under .canvas/worktrees, so Expanse left it alone.`
        }
      }
      const st = await worktrees.status(wt)
      if (!st.exists) return { ok: true, outcome: 'gone' }
      const running = await runningInside(wt)
      if (running.length > 0) {
        return {
          ok: false,
          running,
          reason:
            "Terminals are still running inside the worktree. Windows can't remove a folder a running process is using — stop them first."
        }
      }
      const branch = ws.worktrees?.[0]?.branch ?? ''
      if (!st.dirty) {
        const r = await worktrees.removeIfClean(wt)
        if (r.removed) {
          return { ok: true, outcome: 'removed', detail: `worktree removed, branch ${branch} kept` }
        }
        const again = await worktrees.status(wt)
        if (again.dirty) {
          return {
            ok: false,
            dirty: again.changed,
            reason: 'The worktree has uncommitted changes.'
          }
        }
        return { ok: false, reason: `git worktree remove failed — ${r.reason ?? 'unknown'}` }
      }
      if (choice === undefined) {
        return { ok: false, dirty: st.changed, reason: 'The worktree has uncommitted changes.' }
      }
      if (choice === 'keep') {
        return { ok: true, outcome: 'archived', detail: `kept on disk at ${wt} — nothing ran` }
      }
      const out = await worktrees.dispose(wt, choice, ws.name)
      const after = await worktrees.status(wt)
      if (!after.exists) return { ok: true, outcome: 'removed', detail: out.detail }
      return { ok: false, dirty: after.changed, reason: out.detail }
    },

    dirsExist(paths) {
      const project = deps.getProjectDir()
      return (Array.isArray(paths) ? paths : []).map((raw) => {
        const rel = normalizeWorkspaceRoot(raw)
        return project !== null && rel !== null && isDir(underProject(project, rel))
      })
    },

    async depsPrompt(workspaceId, boardId, opts = {}) {
      // Single-use: the arm is spent by the first WRITE attempt (or a definitive refusal). A HELD
      // prompt keeps it, so the human can send it once the agent is at its prompt.
      const arm = depsArms.get(workspaceId)
      if (!arm || now() - arm.at > DEPS_ARM_TTL_MS) {
        depsArms.delete(workspaceId)
        return { ok: false, reason: 'No dependency prompt is armed for this workspace.' }
      }
      if (arm.busy) return { ok: false, reason: 'The dependency prompt is already on its way.' }
      arm.busy = true
      const spend = (reason: string): WorkspaceDepsPromptResult => {
        depsArms.delete(workspaceId)
        return { ok: false, reason }
      }
      try {
        let cwd = deps.terminalCwd(boardId)
        for (let w = 0; !cwd && w < DEPS_SESSION_WAIT_MS; w += DEPS_SESSION_POLL_MS) {
          await sleep(DEPS_SESSION_POLL_MS)
          cwd = deps.terminalCwd(boardId)
        }
        if (!cwd) return spend('The starter terminal never started.')
        if (!isWithinPath(await realOrSelf(arm.cwd), await realOrSelf(cwd))) {
          return spend("That terminal isn't inside the new workspace.")
        }
        const settled = SETTLED.has(await deps.awaitReady(boardId))
        // Never write into the agent's own first-run gate: Claude Code's "trust this folder?"
        // would take the prompt's Enter as its answer, and the default is "No, exit".
        if (trustGateShowing(deps.screenTail(boardId))) {
          return {
            ok: false,
            hold: 'trust-gate',
            reason: 'The agent is asking whether to trust this folder.'
          }
        }
        if (!settled && opts.now !== true) {
          return { ok: false, hold: 'not-ready', reason: 'The agent has not settled yet.' }
        }
        depsArms.delete(workspaceId)
        try {
          const { delivery } = await deps.sendPrompt(boardId, DEPS_PROMPT)
          return { ok: true, delivery }
        } catch (err) {
          return { ok: false, reason: errText(err) }
        }
      } finally {
        arm.busy = false
      }
    }
  }
}

/**
 * Project Workspaces WS-4 — the `workspace:*` IPC contract (create / delete / status), shared by
 * MAIN (`workspaceStore.ts` + `workspaceIpc.ts`), the preload bridge (`workspaceApi.ts`) and the
 * renderer dialogs. Pure types: no Node / DOM / Electron imports, so it compiles under
 * tsconfig.node, tsconfig.preload and tsconfig.web alike (the `closeGuardTypes` precedent).
 *
 * Design: docs/research/2026-11-02-project-workspaces/README.md §4.3 (create / delete flow).
 * Every path in this contract is PROJECT-RELATIVE POSIX (`'api'`, `'.'`) — MAIN resolves it against
 * the open project and realpaths it; the renderer never sends or receives an absolute path except
 * the starter terminal's `cwd`, which MAIN hands back after it has proven the folder exists.
 */

/** How a workspace is backed (§4.3 step 1). `folder` = "Use folder as-is", the default. */
export type WorkspaceGitMode = 'folder' | 'worktree' | 'attach'

/** The human-chosen fate of a DIRTY worktree — the swarm's disposition vocabulary, reused. */
export type WorkspaceDisposition = 'keep' | 'commit' | 'stash' | 'discard'

/** Closed set, so MAIN can re-validate a renderer-sent choice (anything else ⇒ refused). */
export const WORKSPACE_DISPOSITIONS: readonly WorkspaceDisposition[] = [
  'keep',
  'commit',
  'stash',
  'discard'
]

/** `workspace:probe` — what one folder is, git-wise. */
export type WorkspaceProbeResult =
  | {
      ok: true
      /** The folder, canonical project-relative (`'api'`, `'.'`). */
      root: string
      /** The repo that owns the folder, project-relative — absent when the folder is not in a repo
       *  (or its repo lies OUTSIDE the project, see `gitReason`). */
      repoRoot?: string
      /** The repo's checked-out branch; `null` when HEAD is detached. Only with `repoRoot`. */
      current?: string | null
      /** Why the git modes are off, as a sentence (not a repo; or the repo is outside the project). */
      gitReason?: string
    }
  | { ok: false; reason: string }

/** `workspace:pickFolder` — the OS folder picker, opened at the project. `reason: 'cancelled'` when
 *  the human closed it; any other reason is a refusal to show (outside the project, not a folder). */
export type WorkspacePickResult = { ok: true; root: string } | { ok: false; reason: string }

/** `workspace:listRepos` — every git repo in the project (root + one level down). */
export interface WorkspaceRepo {
  /** Project-relative repo root: `'.'` for the project itself, else the child folder (`'api'`). */
  rel: string
}

/** `workspace:listBranches` — a repo's branches as they are on disk (never fetched). */
export type WorkspaceBranchesResult =
  | { ok: true; current: string | null; local: string[]; remote: string[] }
  | { ok: false; reason: string }

/** `workspace:create` input. The renderer has already checked the name is free. */
export interface WorkspaceCreateRequest {
  name: string
  /** The folder the workspace is ABOUT, project-relative. */
  root: string
  mode: WorkspaceGitMode
  /** `worktree` mode: the branch the new `ws/<slug>` starts from. */
  base?: string
  /** `attach` mode: the existing LOCAL branch to check out. */
  branch?: string
  /**
   * O-9: the "Ask the agent to install dependencies" tick (worktree modes only). MAIN arms ONE
   * single-use prompt for this workspace; `workspace:depsPrompt` spends it.
   */
  deps?: boolean
}

/** The worktree half of a created workspace — exactly the persisted `WorkspaceWorktree` shape. */
export interface WorkspaceWorktreeRecord {
  repoRoot: string
  worktree: string
  branch: string
  baseRef: string
  base: string
}

export type WorkspaceCreateResult =
  | {
      ok: true
      /** MAIN-minted uuid — the renderer writes the record under this id. */
      id: string
      /** The canonical root to store. */
      root: string
      worktree?: WorkspaceWorktreeRecord
      /** ABSOLUTE effective root (the worktree's copy of `root`, or `root` itself), stat-proven —
       *  the starter terminal's cwd. */
      cwd: string
    }
  | { ok: false; reason: string }

/** `workspace:status` — what deleting this workspace would meet. */
export type WorkspaceStatusResult =
  | {
      ok: true
      kind: 'folder' | 'worktree'
      /** The folder (folder kind) / the worktree (worktree kind) is on disk. */
      exists: boolean
      dirty: boolean
      /** Changed entries (`git status --porcelain`), 0 when clean / not git-backed. */
      changed: number
      /** Board ids of LIVE terminals spawned inside the worktree — they must stop before removal
       *  (Windows refuses to delete a folder that is any process's cwd). Always `[]` for folders. */
      running: string[]
    }
  | { ok: false; reason: string }

export interface WorkspaceDeleteRequest {
  id: string
  /** Only for a dirty worktree, after the human chose. Absent ⇒ a clean-only removal. */
  disposition?: WorkspaceDisposition
}

export type WorkspaceDeleteResult =
  | {
      ok: true
      /**
       * - `record` — folder-as-is: nothing on disk was touched; drop the record.
       * - `removed` — the worktree is gone (`git worktree remove`); the branch is kept.
       * - `gone` — the worktree was already missing from disk; drop the record.
       * - `archived` — Keep on disk: the record stays with `state: 'archived'`.
       */
      outcome: 'record' | 'removed' | 'gone' | 'archived'
      detail?: string
    }
  | {
      ok: false
      reason: string
      /** Set when the worktree is dirty and no disposition was given — the dialog asks. */
      dirty?: number
      /** Set when live terminals still sit inside the worktree. */
      running?: string[]
    }

/**
 * Why a dependency prompt was HELD (not written, still armed): the agent is showing its own
 * first-run gate (Claude Code's "trust this folder?" — an Enter there answers it), or it has not
 * settled yet. The human sends it once the agent is at its prompt (`workspace:depsPrompt` with
 * `now`).
 */
export type WorkspaceDepsHold = 'trust-gate' | 'not-ready'

/** `workspace:depsPrompt` outcome. `delivery` mirrors the dispatch gate's honest ack. */
export type WorkspaceDepsPromptResult =
  | { ok: true; delivery: 'ready' | 'unconfirmed' }
  | { ok: false; reason: string; hold?: WorkspaceDepsHold }

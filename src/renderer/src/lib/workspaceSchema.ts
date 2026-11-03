/**
 * v24 Project Workspaces — the persisted shape, its validation, and its load reconcile. A leaf of
 * boardSchema (the kanbanSchema / swarmBoardSchema precedent): the back-reference to boardSchema is
 * TYPE-ONLY, so there is no runtime import cycle. The value rules (colour tokens, goal, paths, refs)
 * are shared with MAIN's mirror via `src/shared/workspaceRules.ts`.
 *
 * Model (design: docs/research/2026-11-02-project-workspaces/README.md §4.1, Option B): a workspace
 * is a DOC-LEVEL record (`canvas.json` `workspaces[]`, which is why v24 also raises the floor), and a
 * board joins one through its own optional `workspaceId` — 0 or 1 per board (D-3); absent ⇒ the
 * board is project-level. Plain groups are unchanged and may span workspaces.
 */
import type { CanvasDoc } from './boardSchema'
import { sanitizeGroupName } from '../../../shared/groupName'
import {
  WORKSPACE_COLORS,
  WORKSPACE_WORKTREES_MAX,
  isValidWorkspaceGoal,
  isValidWorkspaceRef,
  isWorkspaceColor,
  normalizeWorkspaceRoot,
  type WorkspaceColor
} from '../../../shared/workspaceRules'

export type { WorkspaceColor }

/** A git worktree backing a workspace (O-1, O-10). Every path is project-relative POSIX. */
export interface WorkspaceWorktree {
  /** The repo that owns the worktree: `'api'` in a polyrepo, `'.'` when the project is the repo. */
  repoRoot: string
  /** The worktree folder: `.canvas/worktrees/<slug>` (O-1). */
  worktree: string
  /** The worktree's branch: `ws/<slug>` when Expanse made it, else the attached branch. */
  branch: string
  /** The base branch the user picked (`'release'`); shown in the status. */
  baseRef: string
  /** The base commit sha at creation (future diff / merge views). */
  base: string
}

/** One workspace (§4.1). Unknown extra keys ride through a load + save untouched (ADR 0007). */
export interface Workspace {
  /** uuid (MAIN mints it once the WS-4 IPC lands). */
  id: string
  /** `sanitizeGroupName`-clean, non-empty, unique per project (case-insensitive). */
  name: string
  /** One line, at most 200 code units, no control characters. May be empty. */
  goal: string
  /** A fixed token (`WORKSPACE_COLORS`), never free hex. */
  color: WorkspaceColor
  /** The folder this workspace is ABOUT: project-relative POSIX, inside the project; `'.'` = all. */
  root: string
  /** Present iff Expanse allocated (or attached) worktrees. A list so multi-repo needs no second
   *  format change (O-10); v1 validation rejects more than one. */
  worktrees?: WorkspaceWorktree[]
  /** The record kept after a "keep the worktree on disk" delete (§4.3). */
  state?: 'archived'
  /** D-7 / O-12 opt-out ("Keep my arrangement"): focus moves only the camera. */
  keepLayout?: boolean
}

/** O-10: the remembered base branch per repo, keyed by project-relative repo root (`'api'`, `'.'`). */
export type RepoDefaults = Record<string, { base: string }>

/** The two v24 doc-level fields, as the store hands them to `toObject`. */
export interface WorkspaceDocFields {
  workspaces: Workspace[]
  repoDefaults?: RepoDefaults
}

/** A verdict on one raw workspace. `drop: true` = a reconcile drop (the record is well-formed but
 *  its paths escape the project) rather than a validation failure. */
export type WorkspaceVerdict =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: string; drop?: true }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate one raw workspace and return its canonical form (paths normalized, an unknown colour
 * coerced to the first token — forward-compat: a token a NEWER app adds rides in additively instead
 * of failing the doc, the v15 viewport-clamp discipline). Pure; shared by the load reconcile and
 * the store's write path, so the app can never write a record it would refuse to read.
 */
export function checkWorkspace(raw: unknown): WorkspaceVerdict {
  const bad = (reason: string): WorkspaceVerdict => ({ ok: false, reason })
  if (!isRecord(raw)) return bad('workspace is not an object')
  const { id, name, goal, color, root, worktrees, state, keepLayout } = raw
  if (typeof id !== 'string' || id.length === 0) return bad('workspace has an empty/non-string id')
  const label = JSON.stringify(typeof name === 'string' ? name : id)
  if (typeof name !== 'string' || name === '' || sanitizeGroupName(name) !== name) {
    return bad(`workspace ${label} has an invalid name`)
  }
  if (!isValidWorkspaceGoal(goal)) return bad(`workspace ${label} has an invalid goal`)
  if (typeof color !== 'string') return bad(`workspace ${label} has a non-string color`)
  if (typeof root !== 'string') return bad(`workspace ${label} has a non-string root`)
  if (state !== undefined && state !== 'archived') return bad(`workspace ${label} has a bad state`)
  if (keepLayout !== undefined && typeof keepLayout !== 'boolean') {
    return bad(`workspace ${label} has a non-boolean keepLayout`)
  }
  const escapes = (): WorkspaceVerdict => ({
    ok: false,
    drop: true,
    reason: `Workspace ${label} was removed: its folder is outside the project.`
  })
  const normRoot = normalizeWorkspaceRoot(root)
  if (normRoot === null) return escapes()
  const out: Workspace = {
    ...(raw as unknown as Workspace),
    root: normRoot,
    color: isWorkspaceColor(color) ? color : WORKSPACE_COLORS[0]
  }
  if (worktrees === undefined) return { ok: true, workspace: out }
  if (!Array.isArray(worktrees)) return bad(`workspace ${label} worktrees is not an array`)
  if (worktrees.length > WORKSPACE_WORKTREES_MAX) {
    return bad(`workspace ${label} has more than ${WORKSPACE_WORKTREES_MAX} worktree`)
  }
  const wts: WorkspaceWorktree[] = []
  for (const wt of worktrees as unknown[]) {
    if (!isRecord(wt)) return bad(`workspace ${label} has a malformed worktree`)
    if (typeof wt.repoRoot !== 'string' || typeof wt.worktree !== 'string') {
      return bad(`workspace ${label} has a worktree with a non-string path`)
    }
    if (![wt.branch, wt.baseRef, wt.base].every(isValidWorkspaceRef)) {
      return bad(`workspace ${label} has a worktree with an invalid branch/baseRef/base`)
    }
    const repoRoot = normalizeWorkspaceRoot(wt.repoRoot)
    const worktree = normalizeWorkspaceRoot(wt.worktree)
    if (repoRoot === null || worktree === null) return escapes()
    wts.push({ ...(wt as unknown as WorkspaceWorktree), repoRoot, worktree })
  }
  return { ok: true, workspace: { ...out, worktrees: wts } }
}

/** True when `name` is already used by another workspace (case-insensitive; `exceptId` skips the
 *  workspace being renamed). */
export function isWorkspaceNameTaken(
  workspaces: readonly Workspace[],
  name: string,
  exceptId?: string
): boolean {
  const key = name.toLowerCase()
  return workspaces.some((w) => w.id !== exceptId && w.name.toLowerCase() === key)
}

/** O-10 cache: degrade-don't-reject (like the backdrop) — a malformed entry, or one keyed by a path
 *  outside the project, is dropped; the doc still loads. Keys come back canonicalized. */
function reconcileRepoDefaults(raw: unknown): RepoDefaults {
  if (!isRecord(raw)) return {}
  // Object.fromEntries defines OWN properties, so a `__proto__` key can never reach a prototype.
  return Object.fromEntries(
    Object.entries(raw).flatMap(([k, v]) => {
      const key = normalizeWorkspaceRoot(k)
      const base = isRecord(v) ? v.base : undefined
      return key !== null && isValidWorkspaceRef(base) ? [[key, { base }]] : []
    })
  )
}

/** `toObject`'s repoDefaults key: omitted while empty, so a project that never remembered a base
 *  carries no dead key. */
export function repoDefaultsField(rd: RepoDefaults | undefined): { repoDefaults?: RepoDefaults } {
  return rd && Object.keys(rd).length > 0 ? { repoDefaults: rd } : {}
}

/** Load-time notices (a dropped workspace), keyed by the doc fromObject returned — a WeakMap so the
 *  notice never rides into `canvas.json` and dies with the doc. */
const loadNotices = new WeakMap<object, string[]>()

/** The workspace drops `reconcileWorkspaces` recorded for this loaded doc (empty when none). */
export function workspaceLoadNotices(doc: object): readonly string[] {
  return loadNotices.get(doc) ?? []
}

/**
 * fromObject's v24 reconcile (runs post-migrate, after the dangling board-ref sweep). Mutates `doc`:
 *  - validates every workspace (`checkWorkspace`): a malformed record FAILS the doc (`.bak`
 *    recovery), as strict as groups; a non-array `workspaces` fails too;
 *  - DROPS a workspace whose root / worktree paths escape the project, and a later duplicate id or
 *    name — each drop is recorded as a notice for the load path to toast;
 *  - KEEPS an empty workspace (unlike groups — a workspace is a folder + goal, not a board set);
 *  - clears a board's dangling `workspaceId` (the board becomes project-level);
 *  - a docked swarm worker inherits its swarm board's `workspaceId` (it has no canvas presence of
 *    its own, so it always belongs where its host does);
 *  - degrades `repoDefaults` (see reconcileRepoDefaults), deleting the key when nothing is left.
 */
export function reconcileWorkspaces(doc: CanvasDoc, fail: (msg: string) => never): void {
  const raw = (doc as { workspaces?: unknown }).workspaces
  if (raw !== undefined && !Array.isArray(raw)) fail('workspaces is not an array')
  const kept: Workspace[] = []
  const notices: string[] = []
  for (const w of (raw as unknown[] | undefined) ?? []) {
    const v = checkWorkspace(w)
    if (!v.ok) {
      if (v.drop) notices.push(v.reason)
      else fail(v.reason)
      continue
    }
    const ws = v.workspace
    if (kept.some((k) => k.id === ws.id) || isWorkspaceNameTaken(kept, ws.name)) {
      notices.push(`Workspace ${JSON.stringify(ws.name)} was removed: it duplicates another.`)
      continue
    }
    kept.push(ws)
  }
  doc.workspaces = kept
  const live = new Set(kept.map((w) => w.id))
  const hostWorkspace = new Map<string, string | undefined>()
  for (const b of doc.boards) {
    const wid: unknown = b.workspaceId
    if (wid !== undefined && typeof wid !== 'string') fail('board has a non-string workspaceId')
    if (wid !== undefined && !live.has(wid as string)) delete b.workspaceId
    if (b.type === 'swarm') hostWorkspace.set(b.id, b.workspaceId)
  }
  for (const b of doc.boards) {
    if (b.type !== 'terminal' || b.dockedIn === undefined) continue
    const inherited = hostWorkspace.get(b.dockedIn)
    if (inherited === undefined) delete b.workspaceId
    else b.workspaceId = inherited
  }
  const defaults = reconcileRepoDefaults((doc as { repoDefaults?: unknown }).repoDefaults)
  if (Object.keys(defaults).length > 0) doc.repoDefaults = defaults
  else delete doc.repoDefaults
  if (notices.length > 0) loadNotices.set(doc, notices)
}

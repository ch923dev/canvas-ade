/**
 * v24 Project Workspaces — MAIN's view of the renderer's workspace records: the mirror types and
 * the `mcp:boards` sanitizer, extracted from boardRegistry (max-lines ratchet; boardRegistry keeps
 * the storage + `listWorkspaces()` and re-exports these). The value rules are the renderer's own,
 * shared via `src/shared/workspaceRules.ts`, so a record the renderer persists is never one MAIN
 * drops. Design: docs/research/2026-11-02-project-workspaces §4.1.
 */
import { sanitizeGroupName } from '../shared/groupName'
import { MAX_CONTEXT_ID } from '../shared/spatialTypes'
import {
  WORKSPACE_COLORS,
  WORKSPACE_WORKTREES_MAX,
  isValidWorkspaceGoal,
  isValidWorkspaceRef,
  isWorkspaceColor,
  normalizeWorkspaceRoot,
  type WorkspaceColor
} from '../shared/workspaceRules'
import { scanOf } from './mirrorScan'

/** A workspace's git worktree, as mirrored to MAIN (v24 — `WorkspaceWorktree` in the renderer's
 *  `lib/workspaceSchema.ts`). Every path is project-relative POSIX and lexically inside the project. */
export interface WorkspaceWorktreeMirror {
  repoRoot: string
  worktree: string
  branch: string
  baseRef: string
  base: string
}

/**
 * A project workspace the renderer mirrors to MAIN (v24 — mirror of `Workspace` in the renderer's
 * `lib/workspaceSchema.ts`). MAIN-side source of truth for WS-3's spawn authority (a board's
 * `workspaceId` resolves HERE, never against a renderer-sent root) and later WS-7 confinement.
 * Session state only; not exposed to agents until WS-9.
 */
export interface WorkspaceMirror {
  id: string
  name: string
  goal: string
  color: WorkspaceColor
  root: string
  worktrees?: WorkspaceWorktreeMirror[]
  state?: 'archived'
  keepLayout?: boolean
}

/** Cap the workspace mirror like the groups mirror (a real project holds a handful). */
const MAX_WORKSPACES = 200

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** One mirrored worktree, or null when it is malformed or a path leaves the project. */
function sanitizeWorktree(input: unknown): WorkspaceWorktreeMirror | null {
  if (!isRecord(input)) return null
  const repoRoot = normalizeWorkspaceRoot(input.repoRoot)
  const worktree = normalizeWorkspaceRoot(input.worktree)
  const { branch, baseRef, base } = input
  if (repoRoot === null || worktree === null) return null
  if (!isValidWorkspaceRef(branch) || !isValidWorkspaceRef(baseRef) || !isValidWorkspaceRef(base)) {
    return null
  }
  return { repoRoot, worktree, branch, baseRef, base }
}

/**
 * Keep only well-formed workspace entries (v24); drop anything else. `mcp:boards` is an IPC channel,
 * so this re-applies the renderer's rules from `src/shared/workspaceRules.ts` instead of trusting
 * them, and is bounded like boardRegistry's `sanitizePorts`: the scan is windowed ({@link scanOf}), at most
 * {@link MAX_WORKSPACES} entries are kept, and ids are de-duplicated (first wins). Per entry:
 * `id` at most {@link MAX_CONTEXT_ID}; `name` already `sanitizeGroupName`-clean and non-empty;
 * `goal` one line of at most 200; `root` and every worktree path lexically INSIDE the project
 * (canonicalized); at most {@link WORKSPACE_WORKTREES_MAX} worktree(s), each well-formed; `state`
 * absent or `'archived'`; `keepLayout` absent or boolean. A failing rule drops the WHOLE workspace —
 * a half-trusted record would let WS-3 resolve a cwd from a field this check never vetted. An
 * unknown colour token is coerced to the first (the renderer's read-time clamp). Only these fields
 * are read — nothing else on the payload reaches the mirror.
 */
export function sanitizeWorkspaces(input: unknown): WorkspaceMirror[] {
  if (!Array.isArray(input)) return []
  const out: WorkspaceMirror[] = []
  for (const w of scanOf(input, MAX_WORKSPACES)) {
    if (out.length >= MAX_WORKSPACES) break
    if (!isRecord(w)) continue
    const { name, goal, color, worktrees, state, keepLayout } = w
    const id = typeof w.id === 'string' && w.id.length <= MAX_CONTEXT_ID ? w.id : ''
    if (id === '' || out.some((x) => x.id === id)) continue
    if (typeof name !== 'string' || name === '' || sanitizeGroupName(name) !== name) continue
    if (!isValidWorkspaceGoal(goal) || typeof color !== 'string') continue
    if (state !== undefined && state !== 'archived') continue
    if (keepLayout !== undefined && typeof keepLayout !== 'boolean') continue
    const root = normalizeWorkspaceRoot(w.root)
    if (root === null) continue
    const entry: WorkspaceMirror = {
      id,
      name,
      goal,
      color: isWorkspaceColor(color) ? color : WORKSPACE_COLORS[0],
      root
    }
    if (worktrees !== undefined) {
      if (!Array.isArray(worktrees) || worktrees.length > WORKSPACE_WORKTREES_MAX) continue
      const wts = worktrees.map(sanitizeWorktree)
      if (wts.some((x) => x === null)) continue
      entry.worktrees = wts as WorkspaceWorktreeMirror[]
    }
    if (state === 'archived') entry.state = state
    if (keepLayout !== undefined) entry.keepLayout = keepLayout
    out.push(entry)
  }
  return out
}

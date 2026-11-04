/**
 * WS-7 — workspace confinement on the surfaces Expanse owns (design: docs/research/2026-11-02-
 * project-workspaces §4.4; D-4 "enforce what Expanse owns"). Every MCP / Jarvis call is made in a
 * SCOPE: the caller's own workspace **W**, or **PROJECT** (a project-level board, the in-process
 * `'app'` orchestrator, Jarvis). The scope is derived from MAIN's own mirrors — the caller's
 * token-derived board id → its mirrored `workspaceId` → the mirrored workspace — never from
 * anything the caller claims.
 *
 *   | surface                         | W caller                              | PROJECT caller          |
 *   | spawn_board / spawn_group       | joins W; cwd must stay inside W       | cwd inside the project; |
 *   |                                 |                                       | a workspace root ⇒ joins|
 *   | configure_board cwd             | (target-based) inside the TARGET's workspace, else the project |
 *   | relay / assign, planning, cards,| target in W or project-level;         | any                     |
 *   |   close, configure (target)     | another workspace ⇒ refused           |                         |
 *   | tidy_canvas / arrange_main_board| default scope = W's boards            | unchanged               |
 *
 * Refusals are `invalid_input` with one human sentence. Paths are checked through their realpaths
 * (`isWithin`), so a `..` or a symlink/junction escape is refused like any other outside path.
 *
 * Known limits (documented in ADR 0014 › Confinement):
 *  - `@expanse-ade/mcp` 0.28.x calls configure_board, the planning-element and kanban-card tools
 *    WITHOUT the caller's board id, so their target-in-scope check is DORMANT until the package
 *    passes the trailing `{ sourceBoardId }` the guarded methods already accept (WS-9). Their
 *    caller-independent rules (configure_board's cwd) apply now.
 *  - A caller whose board is not on the ACTIVE canvas (another project's agent) reads as PROJECT.
 *  - Nothing here stops a shell agent running `cd ../other && …` — only Expanse's own surfaces.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isWithin } from './pathSafe'
import { McpToolError } from './mcpToolError'
import type { WorkspaceMirror } from './workspaceMirror'
import { effectiveRoot } from '../shared/workspaceRules'

/** The board fields the scope rules read (MAIN's board mirror satisfies it). */
export interface ScopeBoard {
  id: string
  type: string
  title?: string
  workspaceId?: string
  dockedIn?: string
}

export interface WorkspaceScopeDeps {
  boards(): readonly ScopeBoard[]
  workspaces(): readonly WorkspaceMirror[]
  projectDir(): string | null
  /** Injectable for tests; defaults to the native realpath (resolves junctions + 8.3 names). */
  realpath?: (p: string) => string
}

export type CallerScope = { kind: 'project' } | { kind: 'workspace'; ws: WorkspaceMirror }

/** The trailing caller argument the guarded write methods accept (the WS-9 package contract). */
export interface ScopeCaller {
  sourceBoardId?: string
}

const PROJECT: CallerScope = { kind: 'project' }
const refuse = (message: string): McpToolError => new McpToolError('invalid_input', message)
const shown = (rel: string): string => (rel === '.' ? './' : `${rel}/`)

/** The mirrored workspace a board belongs to, or undefined (project-level / dangling id). */
function workspaceOf(deps: WorkspaceScopeDeps, board: ScopeBoard | undefined) {
  const id = board?.workspaceId
  return id ? deps.workspaces().find((w) => w.id === id) : undefined
}

/**
 * The caller's scope. No board id (the `'app'` orchestrator, Jarvis) ⇒ PROJECT. A board in a
 * workspace MAIN's mirror knows ⇒ that workspace. A board not on the active canvas ⇒ PROJECT.
 */
export function callerScope(deps: WorkspaceScopeDeps, boardId: string | undefined): CallerScope {
  if (!boardId) return PROJECT
  const ws = workspaceOf(
    deps,
    deps.boards().find((b) => b.id === boardId)
  )
  return ws ? { kind: 'workspace', ws } : PROJECT
}

/** The realpath of an existing directory, or null (missing, not a directory, unreadable). */
function realDir(deps: WorkspaceScopeDeps, p: string): string | null {
  try {
    const real = (deps.realpath ?? ((q: string) => fs.realpathSync.native(q)))(p)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** A workspace's effective root: absolute (lexical) + realpath + display form. */
function rootOf(deps: WorkspaceScopeDeps, ws: WorkspaceMirror, tool: string) {
  const projectDir = deps.projectDir()
  const rel = effectiveRoot(ws)
  if (!projectDir || rel === null) {
    throw refuse(`${tool}: workspace "${ws.name}" has no usable folder right now.`)
  }
  const abs = path.resolve(projectDir, rel)
  const real = realDir(deps, abs)
  if (!real) {
    throw refuse(`${tool}: workspace "${ws.name}" folder is missing (${shown(rel)}).`)
  }
  return { abs, real, shown: shown(rel) }
}

/** `cwd` (absolute, or relative to `base`) as a lexical absolute path + its realpath. */
function resolveCwd(deps: WorkspaceScopeDeps, base: string, cwd: string, tool: string) {
  const abs = path.resolve(base, cwd.trim())
  const real = realDir(deps, abs)
  if (!real) throw refuse(`${tool}: cwd "${cwd.trim()}" is not an existing folder.`)
  return { abs, real }
}

/** cwd inside workspace `ws` (relative ⇒ under its root). Returns the lexical absolute path. */
function cwdInWorkspace(deps: WorkspaceScopeDeps, ws: WorkspaceMirror, cwd: string, tool: string) {
  const root = rootOf(deps, ws, tool)
  const { abs, real } = resolveCwd(deps, root.abs, cwd, tool)
  if (!isWithin(root.real, real)) {
    throw refuse(
      `${tool}: cwd "${cwd.trim()}" is outside workspace "${ws.name}" (${root.shown}) — ` +
        `boards in a workspace stay inside its folder.`
    )
  }
  return abs
}

/** cwd inside the open project (relative ⇒ under it); null project ⇒ unchecked (nothing to escape). */
function cwdInProject(deps: WorkspaceScopeDeps, cwd: string, tool: string): string {
  const projectDir = deps.projectDir()
  if (!projectDir) return cwd
  const realProject = realDir(deps, projectDir)
  const { abs, real } = resolveCwd(deps, projectDir, cwd, tool)
  if (!realProject || !isWithin(realProject, real)) {
    throw refuse(`${tool}: cwd "${cwd.trim()}" is outside the project — boards start inside it.`)
  }
  return abs
}

/** The deepest workspace whose effective root contains `realCwd` (a PROJECT spawn joins it). */
function workspaceContaining(deps: WorkspaceScopeDeps, realCwd: string) {
  const projectDir = deps.projectDir()
  if (!projectDir) return undefined
  let best: { ws: WorkspaceMirror; depth: number } | undefined
  for (const ws of deps.workspaces()) {
    const rel = ws.state === 'archived' ? null : effectiveRoot(ws)
    const real = rel === null ? null : realDir(deps, path.resolve(projectDir, rel))
    if (real && isWithin(real, realCwd) && (!best || real.length > best.depth)) {
      best = { ws, depth: real.length }
    }
  }
  return best?.ws
}

/**
 * Where a spawned TERMINAL starts and which workspace the new board joins (spawn_board /
 * spawn_group / Jarvis). W: the board joins W; no cwd ⇒ W's root (resolved at PTY spawn, WS-3, but
 * a missing folder is refused HERE so no dead board is created); a cwd must stay inside W.
 * PROJECT: no cwd ⇒ project-level; a cwd must stay inside the project, and one inside a workspace
 * root joins that workspace (the deepest, when roots nest).
 */
export function assertCwdInScope(
  deps: WorkspaceScopeDeps,
  scope: CallerScope,
  cwd: string | undefined,
  tool: string
): { cwd?: string; workspaceId?: string } {
  const hasCwd = typeof cwd === 'string' && cwd.trim().length > 0
  if (scope.kind === 'workspace') {
    if (!hasCwd) {
      rootOf(deps, scope.ws, tool)
      return { workspaceId: scope.ws.id }
    }
    return { workspaceId: scope.ws.id, cwd: cwdInWorkspace(deps, scope.ws, cwd!, tool) }
  }
  if (!hasCwd) return {}
  const abs = cwdInProject(deps, cwd!, tool)
  const real = realDir(deps, abs)
  const joined = real ? workspaceContaining(deps, real) : undefined
  return { cwd: abs, ...(joined ? { workspaceId: joined.id } : {}) }
}

/** The spawn input fields placement reads (spawn_board's wire input + the swarm's dock host). */
export interface SpawnPlacementInput {
  type: string
  cwd?: string
  sourceBoardId?: string
  dockedIn?: string
}

/**
 * Where a spawn_board board goes: its workspace + its checked cwd (throws the refusal). Membership
 * comes from the CALLER, never the input. A non-terminal joins W (a cwd on it is left for the
 * lifecycle's own terminal-only refusal). A swarm-DOCKED worker stays project-level — the swarm
 * board carries the membership, and its worktree cwd sits outside every workspace root, so WS-3's
 * spawn check would refuse it — but its cwd is still kept inside the project.
 */
export function placeSpawn(
  deps: WorkspaceScopeDeps,
  input: SpawnPlacementInput
): { cwd?: string; workspaceId?: string } {
  const docked = typeof input.dockedIn === 'string' && input.dockedIn.length > 0
  if (input.type === 'terminal' && docked) {
    const { cwd } = assertCwdInScope(deps, PROJECT, input.cwd, 'spawn_board')
    return cwd ? { cwd } : {}
  }
  const scope = callerScope(deps, input.sourceBoardId)
  if (input.type !== 'terminal') {
    return scope.kind === 'workspace' ? { workspaceId: scope.ws.id } : {}
  }
  return assertCwdInScope(deps, scope, input.cwd, 'spawn_board')
}

/** A workspace's display name by id (the Jarvis confirm names where a spawn lands). */
export function workspaceName(
  deps: WorkspaceScopeDeps,
  id: string | undefined
): string | undefined {
  return id ? deps.workspaces().find((w) => w.id === id)?.name : undefined
}

/**
 * configure_board's new cwd, checked against the TARGET (caller-independent, so it holds even while
 * the package passes no caller id): a workspace board's cwd stays inside its workspace; a
 * project-level board's stays inside the project (else spawn-then-configure would bypass the spawn
 * rule). Membership never changes — moving a board between workspaces is a human action. A blank
 * cwd (reset to the default) and a non-terminal target pass through untouched.
 */
export function assertConfigureCwd(
  deps: WorkspaceScopeDeps,
  target: ScopeBoard | undefined,
  cwd: string
): string {
  if (!target || target.type !== 'terminal' || cwd.trim().length === 0) return cwd
  const ws = workspaceOf(deps, target)
  return ws
    ? cwdInWorkspace(deps, ws, cwd, 'configure_board')
    : cwdInProject(deps, cwd, 'configure_board')
}

/**
 * A W caller may act on boards in W and on project-level boards (a shared kanban, say) — never on
 * another workspace's. Returns the refusal sentence, or null when allowed. An unknown target is left
 * to the method's own not-found handling.
 */
export function targetScopeError(
  deps: WorkspaceScopeDeps,
  scope: CallerScope,
  targetId: string,
  tool: string
): string | null {
  if (scope.kind === 'project') return null
  const target = deps.boards().find((b) => b.id === targetId)
  const tws = workspaceOf(deps, target)
  if (!target || !tws || tws.id === scope.ws.id) return null
  return (
    `${tool}: "${target.title ?? target.id}" belongs to workspace "${tws.name}" — an agent in ` +
    `workspace "${scope.ws.name}" can only reach its own workspace's boards and project-level boards.`
  )
}

/** {@link targetScopeError} as a throw — the single-target write methods' check. */
export function assertTargetInScope(
  deps: WorkspaceScopeDeps,
  scope: CallerScope,
  targetId: string,
  tool: string
): void {
  const error = targetScopeError(deps, scope, targetId, tool)
  if (error !== null) throw refuse(error)
}

/** The arrangeable (non-docked) boards of a workspace — a W caller's default tidy scope. */
export function workspaceBoardIds(deps: WorkspaceScopeDeps, wsId: string): string[] {
  return deps
    .boards()
    .filter((b) => b.workspaceId === wsId && !b.dockedIn)
    .map((b) => b.id)
}

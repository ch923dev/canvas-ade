/**
 * Project Workspaces WS-8 — the shared-context files (design: docs/research/2026-11-02-project-
 * workspaces §4.5, O-6). One `CONTEXT.md` per workspace plus one for the whole project:
 *
 *   `.canvas/workspaces/<id>/CONTEXT.md`        this workspace's live status + the user's notes
 *   `.canvas/workspaces/_project/CONTEXT.md`    one line per workspace + project-wide notes
 *
 * The top half (between the status markers) is Expanse's; `workspaceStatus.ts` rewrites it. Every byte
 * outside the markers is the user's. Agents read the file and never write it (the workspace deny rules
 * cover `.canvas/workspaces/**`).
 *
 * This module owns the PATHS and the scaffold: path-guarded (a safe id, no link anywhere on the way
 * down — an agent's shell can plant a junction even if its Edit tool can't), lazily created on the
 * first status write. Git: the default-private `.canvas/.gitignore` (`*`) already hides it; with the
 * commit opt-in it is tracked, so a team can share notes (`canvasMemory.ts`).
 *
 * It also holds the two small workspace lookups the agent config needs (effective root, the Claude
 * rules for a board) — MAIN-only, no electron import.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ClaudeWorkspaceRules,
  NO_WORKSPACE_RULES,
  buildWorkspaceRules
} from './cliProvisioners/claudeRules'
import type { BoardMirror, WorkspaceMirror } from './boardRegistry'
import { WORKSPACES_DIR } from './canvasMemory'
import { isSafeId } from './safeId'
import { WORKTREE_SUBDIR } from './swarmWorktree'

/** The reserved id of the project-wide roll-up. Never a workspace id (workspace ids are uuids). */
export const PROJECT_CONTEXT_ID = '_project'

/** First line of the status block. Matched by PREFIX, so the trailing hint may change freely. */
export const STATUS_START_PREFIX = '<!-- expanse:status:start'
export const STATUS_START = `${STATUS_START_PREFIX} — Expanse rewrites this part; edit below the line -->`
export const STATUS_END = '<!-- expanse:status:end -->'

const CONTEXT_FILE = 'CONTEXT.md'
const WORKSPACES_REL = `.canvas/${WORKSPACES_DIR}`

/** True for an id that may name a context folder: path-safe, bounded, and not the reserved one. */
export function isWorkspaceContextId(id: unknown): id is string {
  return isSafeId(id) && id !== PROJECT_CONTEXT_ID
}

/** The project-relative POSIX path of a context file — what a File board (the Brief) binds to. */
export function contextRelPath(id: string): string {
  return `${WORKSPACES_REL}/${id}/${CONTEXT_FILE}`
}

/** True when the entry exists and is a symlink / junction (lstat sees junctions as links). */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The absolute path of a context file, or `null` when the id is unsafe or ANY step down from the
 * project (`.canvas`, `workspaces`, `<id>`, `CONTEXT.md`) is a link. A link would make every later
 * write land wherever it points; refusing is the only safe answer.
 */
export function contextFilePath(projectDir: string, id: string): string | null {
  if (id !== PROJECT_CONTEXT_ID && !isWorkspaceContextId(id)) return null
  const steps = ['.canvas', WORKSPACES_DIR, id, CONTEXT_FILE]
  let p = projectDir
  for (const step of steps) {
    p = join(p, step)
    if (isLink(p)) return null
  }
  return p
}

/** The scaffold a new context file starts as: an empty status block, then the notes half. */
export function initialContext(title: string, notesHeading: string): string {
  return [
    STATUS_START,
    `# ${title}`,
    '_Live status, not written yet_',
    STATUS_END,
    '',
    '---',
    `## ${notesHeading}   (yours, edit anytime)`,
    '',
    ''
  ].join('\n')
}

/** Notes heading per file kind (§4.5 example: "My notes"; the roll-up holds project-wide notes). */
export function notesHeadingFor(id: string): string {
  return id === PROJECT_CONTEXT_ID ? 'Project notes' : 'My notes'
}

/**
 * Make sure a context file exists, creating its folders and the scaffold when it does not. An
 * existing file is never touched (`wx`: a file created between the check and the write wins).
 * Returns the absolute path, or `null` when the path guard refuses it.
 */
export function ensureScaffold(
  projectDir: string,
  workspace: { id: string; name: string }
): string | null {
  const file = contextFilePath(projectDir, workspace.id)
  if (!file) return null
  // No exists-check first: `wx` alone decides (CodeQL js/file-system-race), EEXIST ⇒ keep it.
  mkdirSync(join(projectDir, '.canvas', WORKSPACES_DIR, workspace.id), { recursive: true })
  // Re-check after mkdir: a link planted in the meantime must still refuse.
  if (contextFilePath(projectDir, workspace.id) !== file) return null
  try {
    writeFileSync(file, initialContext(workspace.name, notesHeadingFor(workspace.id)), {
      encoding: 'utf8',
      flag: 'wx'
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  return file
}

/** Read a context file, or `undefined` when it is missing, unreadable or refused by the guard. */
export function readContext(projectDir: string, id: string): string | undefined {
  const file = contextFilePath(projectDir, id)
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

// ── Workspace lookups for agent config ─────────────────────────────────────────────────────────

/**
 * A workspace's effective root, absolute: its worktree when it is git-backed, else its folder.
 * TODO(WS-3 rebase): switch to `effectiveRoot` from `src/shared/workspaceRules.ts` once Lane P lands it.
 */
export function effectiveRootAbs(projectDir: string, ws: WorkspaceMirror): string {
  const rel = ws.worktrees?.[0]?.worktree ?? ws.root
  return rel === '.' ? projectDir : join(projectDir, ...rel.split('/'))
}

/** Every folder directly under `<project>/.canvas/worktrees/` (swarm workers + workspaces). */
export function listWorktreeDirs(projectDir: string): string[] {
  const base = join(projectDir, WORKTREE_SUBDIR)
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(base, d.name))
  } catch {
    return []
  }
}

/**
 * The Claude rules a terminal board's cwd should carry (O-5), read from the MAIN mirror at spawn: the
 * board's workspace confines it; a project-level board (or a board whose workspace is gone or
 * archived) gets none, which also sweeps rules an earlier spawn left in that cwd.
 */
export function claudeRulesForBoard(input: {
  projectDir: string
  boardId: string
  boards: readonly BoardMirror[]
  workspaces: readonly WorkspaceMirror[]
  worktreeDirs: readonly string[]
  platform: NodeJS.Platform
}): ClaudeWorkspaceRules {
  const wsId = input.boards.find((b) => b.id === input.boardId)?.workspaceId
  const ws = wsId ? input.workspaces.find((w) => w.id === wsId) : undefined
  if (!ws || ws.state === 'archived') return NO_WORKSPACE_RULES
  return buildWorkspaceRules({
    projectDir: input.projectDir,
    ownRoot: effectiveRootAbs(input.projectDir, ws),
    otherRoots: input.workspaces
      .filter((w) => w.id !== ws.id)
      .map((w) => effectiveRootAbs(input.projectDir, w)),
    worktreeDirs: input.worktreeDirs,
    platform: input.platform
  })
}

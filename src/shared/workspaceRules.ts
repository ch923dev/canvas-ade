/**
 * Project Workspaces (schema v24) — the value rules shared by every place a workspace record
 * crosses a trust boundary: the renderer's load reconcile + store write path
 * (`lib/workspaceSchema.ts`, `store/slices/workspaceSlice.ts`) and MAIN's `mcp:boards` mirror
 * (`boardRegistry.sanitizeWorkspaces`). ONE rule set, so a value the renderer persists is never one
 * MAIN drops (the `groupName.ts` precedent; design: docs/research/2026-11-02-project-workspaces §4.1).
 *
 * Pure string logic: no Node / DOM / Electron imports, so it compiles under tsconfig.node and
 * tsconfig.web alike.
 */

/**
 * The fixed workspace colour tokens (zone tint + chip; never free hex). Hue NAMES, resolved to CSS at
 * render time (WS-5), so the palette can be retuned without a format change. Order = the order
 * {@link nextWorkspaceColor} hands them out.
 */
export const WORKSPACE_COLORS = ['blue', 'green', 'amber', 'violet', 'teal', 'rose'] as const
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number]

/** Max goal length, in UTF-16 code units (§4.1: one line, ≤ 200). */
export const WORKSPACE_GOAL_MAX = 200
/** v1 backs a workspace with at most ONE worktree (O-10); the list shape keeps multi-repo open. */
export const WORKSPACE_WORKTREES_MAX = 1
/** Max length of a stored project-relative path (root / repoRoot / worktree). */
export const WORKSPACE_PATH_MAX = 1024
/** Max length of a stored git ref or sha (branch / baseRef / base). */
export const WORKSPACE_REF_MAX = 256

/** C0 controls, DEL and the C1 range — the same set `groupName.ts` strips. */
function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

function hasControl(s: string): boolean {
  for (const ch of s) if (isControl(ch.codePointAt(0) ?? 0)) return true
  return false
}

/** True for a known colour token. */
export function isWorkspaceColor(v: unknown): v is WorkspaceColor {
  return typeof v === 'string' && (WORKSPACE_COLORS as readonly string[]).includes(v)
}

/** The first colour token no existing workspace uses; cycles once every token is taken. */
export function nextWorkspaceColor(taken: readonly { color: string }[]): WorkspaceColor {
  const used = new Set(taken.map((w) => w.color))
  return (
    WORKSPACE_COLORS.find((c) => !used.has(c)) ??
    WORKSPACE_COLORS[taken.length % WORKSPACE_COLORS.length]
  )
}

/** A stored goal: a string of at most {@link WORKSPACE_GOAL_MAX} code units, no control characters
 *  (so it is always one line). The empty goal is valid. */
export function isValidWorkspaceGoal(v: unknown): v is string {
  return typeof v === 'string' && v.length <= WORKSPACE_GOAL_MAX && !hasControl(v)
}

/**
 * Reduce a raw goal to a valid one: every control character (newline and tab included) becomes a
 * space, space runs collapse, the result is trimmed, then clamped to {@link WORKSPACE_GOAL_MAX} by
 * whole code points (a surrogate pair is never split). The write path's normalizer — its output
 * always passes {@link isValidWorkspaceGoal}.
 */
export function sanitizeWorkspaceGoal(raw: string): string {
  let s = ''
  for (const ch of typeof raw === 'string' ? raw : '') {
    s += isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch
  }
  s = s.replace(/ {2,}/g, ' ').trim()
  if (s.length <= WORKSPACE_GOAL_MAX) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > WORKSPACE_GOAL_MAX) break
    out += ch
  }
  return out.trimEnd()
}

/** A stored git ref / sha: non-empty, at most {@link WORKSPACE_REF_MAX}, no control characters. */
export function isValidWorkspaceRef(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= WORKSPACE_REF_MAX && !hasControl(v)
}

/**
 * Canonicalize a stored project-relative POSIX path (a workspace `root`, a worktree's `repoRoot` /
 * `worktree`, a `repoDefaults` key), or return `null` when it does not stay INSIDE the project
 * (O-7: roots outside the project are refused in v1). Refused:
 *  - empty, over-length, or containing a control character;
 *  - absolute: a leading `/`;
 *  - any backslash (a Windows separator — `C:\x`, `\\server\share`, `\x` — never valid POSIX here);
 *  - any `:` (a drive letter `C:` / `c:x`, or an NTFS alternate data stream `api:stream`);
 *  - a segment made only of dots and spaces other than a lone `.` — `..` itself, plus the forms
 *    Windows path normalization collapses INTO `..` (`...`, `.. `, `. .`).
 * Accepted paths are canonicalized: empty and `.` segments are dropped (`api//x/./`, `./api/` →
 * `api/x`, `api`), and the whole project is `.`. MAIN still realpaths the result before any use
 * (WS-3) — this check is lexical, so a symlink or junction escape is caught there, not here.
 */
export function normalizeWorkspaceRoot(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > WORKSPACE_PATH_MAX) return null
  if (hasControl(raw) || raw.startsWith('/') || raw.includes('\\') || raw.includes(':')) return null
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => /^[. ]+$/.test(s))) return null
  return segments.length === 0 ? '.' : segments.join('/')
}

/** The two fields {@link effectiveRoot} reads — structural, so the renderer's `Workspace` and MAIN's
 *  `WorkspaceMirror` both satisfy it. */
export interface WorkspaceRootFields {
  root: string
  worktrees?: readonly { repoRoot: string; worktree: string }[]
}

/**
 * The folder a workspace's boards actually run in (WS-3, design §4.1), project-relative POSIX:
 *  - no worktree ⇒ the workspace `root` itself;
 *  - a worktree `w` (v1: at most one) ⇒ `w.worktree` + the part of `root` below `w.repoRoot`, so a
 *    monorepo subfolder maps into the worktree (repo `.`, root `packages/api` ⇒
 *    `<wt>/packages/api`) and a polyrepo root IS the worktree (repo `api`, root `api` ⇒ `<wt>`).
 * Returns `null` when a stored path fails {@link normalizeWorkspaceRoot}, or when `root` does not sit
 * at or below the worktree's `repoRoot` (the record cannot name a folder inside that worktree). Pure
 * and lexical like every rule here: MAIN resolves the result against the project and realpaths it
 * before a spawn trusts it.
 */
export function effectiveRoot(ws: WorkspaceRootFields): string | null {
  const root = normalizeWorkspaceRoot(ws.root)
  if (root === null) return null
  const wt = ws.worktrees?.[0]
  if (!wt) return root
  const repoRoot = normalizeWorkspaceRoot(wt.repoRoot)
  const worktree = normalizeWorkspaceRoot(wt.worktree)
  if (repoRoot === null || worktree === null) return null
  let below: string
  if (repoRoot === '.') below = root === '.' ? '' : root
  else if (root === repoRoot) below = ''
  else if (root.startsWith(repoRoot + '/')) below = root.slice(repoRoot.length + 1)
  else return null
  if (below === '') return worktree
  return worktree === '.' ? below : `${worktree}/${below}`
}

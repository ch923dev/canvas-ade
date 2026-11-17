/**
 * Project Workspaces O-5 (design: docs/research/2026-11-02-project-workspaces §4.4) — the Claude Code
 * rules that keep a WORKSPACE agent's Edit/Write tools inside its own workspace:
 *   - `permissions.deny` `Edit(//<abs>/**)` for every OTHER workspace root, every sibling worktree
 *     under `.canvas/worktrees/`, plus `.canvas/canvas.json` and `.canvas/workspaces/**` (the canvas
 *     doc and the shared-context files: Expanse and the human write those, agents only read them);
 *   - `sandbox.enabled` on macOS / Linux (WSL2 runs the Linux build) — Claude Code's filesystem
 *     sandbox does not exist on native Windows.
 *
 * Both are MERGED into the user's own `.claude/settings.local.json`: the user's entries are never
 * reordered or rewritten (byte-identical strings), and only what Expanse added is ever removed. "What
 * Expanse added" can't be read off the file (the user may have written the very same rule), so it is
 * recorded per target dir in a ledger — in memory, persisted through `provisionedDirStore` once bound —
 * and consent revoke sweeps exactly those entries.
 *
 * Spike (WS-8 step 0, Claude Code 2.1.312, native Windows): an `Edit(//m/...)` deny holds for the
 * Edit AND Write tools, for `//m/` and `//M/`, for a path typed in a different case, for a spaced path
 * and for a dot-folder glob. What it does NOT cover is a Bash redirect — documented, not closable here.
 *
 * Pure helpers + a small module-level ledger. MAIN-only; no electron import.
 */
import { win32 } from 'node:path'
import {
  type OwnedClaudeRules,
  persistOwnedRules,
  readOwnedRulesStore
} from './provisionedDirStore'
import { isRecord } from './shared'

export type { OwnedClaudeRules } from './provisionedDirStore'

/** The rules one Claude terminal's cwd should carry. Empty deny + no sandbox = "none of ours". */
export interface ClaudeWorkspaceRules {
  deny: readonly string[]
  sandbox: boolean
}

/** A project-level board (or a board whose workspace is gone): no Expanse rules in its cwd. */
export const NO_WORKSPACE_RULES: ClaudeWorkspaceRules = { deny: [], sandbox: false }

/** Glob metacharacters in Claude Code's gitignore-style path rules. A path holding one is skipped
 *  rather than written as a rule that would match something else. */
const GLOB_META = /[*?[\]]/

/**
 * An absolute path in Claude Code's absolute-rule form: `M:\a b\c` → `//m/a b/c` (drive letter
 * lowercased, the docs' `//c/**` shape), `/home/u/p` → `//home/u/p`. `null` for anything else (a UNC
 * share, a relative path) or a path holding a glob metacharacter.
 */
export function claudeAbsPath(abs: string): string | null {
  let out: string | null = null
  const drive = /^([A-Za-z]):[\\/]/.exec(abs)
  if (drive) {
    const rest = win32.normalize(abs).slice(3).split('\\').filter(Boolean).join('/')
    out = `//${drive[1].toLowerCase()}/${rest}`.replace(/\/$/, '')
  } else if (abs.startsWith('/') && !abs.startsWith('//')) {
    out = '/' + abs.split('/').filter(Boolean).join('/')
    out = out === '/' ? null : '/' + out
  }
  if (out === null || GLOB_META.test(out)) return null
  return out
}

/** Case-insensitive on Windows-style paths; separators normalised. */
function normForCompare(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

/** True when `child` is `parent` itself or sits inside it. */
function isWithinOrSame(parent: string, child: string): boolean {
  const p = normForCompare(parent)
  const c = normForCompare(child)
  return c === p || c.startsWith(p + '/')
}

/**
 * The rules for a terminal in a workspace whose effective root is `ownRoot` (all paths absolute).
 * A root that contains `ownRoot` (a folder workspace on the whole project, say) is skipped: denying
 * it would deny the agent its own workspace. Order is stable (other roots, worktrees, canvas doc,
 * workspaces) and duplicates are dropped, so an unchanged layout re-provisions byte-identically.
 */
export function buildWorkspaceRules(input: {
  projectDir: string
  ownRoot: string
  otherRoots: readonly string[]
  worktreeDirs: readonly string[]
  platform: NodeJS.Platform
}): ClaudeWorkspaceRules {
  const deny: string[] = []
  const add = (rule: string | null): void => {
    if (rule && !deny.includes(rule)) deny.push(rule)
  }
  for (const dir of [...input.otherRoots, ...input.worktreeDirs]) {
    if (isWithinOrSame(dir, input.ownRoot)) continue
    const p = claudeAbsPath(dir)
    add(p && `Edit(${p}/**)`)
  }
  const canvas = claudeAbsPath(input.projectDir)
  if (canvas) {
    add(`Edit(${canvas}/.canvas/canvas.json)`)
    add(`Edit(${canvas}/.canvas/workspaces/**)`)
  }
  return { deny, sandbox: input.platform === 'darwin' || input.platform === 'linux' }
}

/**
 * Merge `desired` into a parsed settings object, given what Expanse `owned` there before. Returns the
 * next settings, the next owned record, and whether anything changed.
 *  - deny: the user's entries (present and not ours) keep their strings and their order; our stale
 *    entries leave; desired entries the file lacks are appended. A desired rule the USER already had
 *    stays theirs (never recorded as ours, so revoke leaves it).
 *  - sandbox: set `sandbox.enabled = true` only when the user has not set `enabled` themselves; an
 *    explicit `false` from the user wins. Ours is removed again when no longer desired.
 *  - A `permissions` / `deny` / `sandbox` value of an unexpected shape is left exactly as it is.
 */
export function mergeRules(
  settings: Record<string, unknown>,
  desired: ClaudeWorkspaceRules,
  owned: OwnedClaudeRules | undefined
): { settings: Record<string, unknown>; owned: OwnedClaudeRules; changed: boolean } {
  const prevOwned = owned ?? { deny: [], sandbox: false }
  const next: Record<string, unknown> = { ...settings }
  const nextOwned: OwnedClaudeRules = { deny: [], sandbox: false }
  let changed = false

  const perms = next.permissions
  if (perms === undefined || isRecord(perms)) {
    const p: Record<string, unknown> = { ...(perms ?? {}) }
    const deny = p.deny
    if (deny === undefined || Array.isArray(deny)) {
      const list = (deny ?? []) as unknown[]
      const wanted = new Set(desired.deny)
      const ours = new Set(prevOwned.deny)
      // Drop our entries that are no longer wanted; keep everything else in place.
      const kept = list.filter((e) => !(typeof e === 'string' && ours.has(e) && !wanted.has(e)))
      const userHas = new Set(
        kept.filter((e): e is string => typeof e === 'string' && !ours.has(e))
      )
      const present = new Set(kept.filter((e): e is string => typeof e === 'string'))
      const appended = desired.deny.filter((r) => !present.has(r))
      const out = [...kept, ...appended]
      nextOwned.deny = desired.deny.filter((r) => !userHas.has(r))
      if (out.length !== list.length || appended.length > 0) {
        changed = true
        // Only a container WE emptied goes away; a user's own `deny: []` / `permissions: {}` stays.
        if (out.length > 0) p.deny = out
        else delete p.deny
        if (Object.keys(p).length > 0) next.permissions = p
        else delete next.permissions
      }
    }
  }

  const sb = next.sandbox
  if (sb === undefined || isRecord(sb)) {
    if (desired.sandbox) {
      if (sb?.enabled === undefined) {
        next.sandbox = { ...(sb ?? {}), enabled: true }
        nextOwned.sandbox = true
        changed = true
      } else {
        nextOwned.sandbox = prevOwned.sandbox && sb.enabled === true
      }
    } else if (prevOwned.sandbox && sb?.enabled === true) {
      const s: Record<string, unknown> = { ...sb }
      delete s.enabled
      if (Object.keys(s).length > 0) next.sandbox = s
      else delete next.sandbox
      changed = true
    }
  }

  return { settings: next, owned: nextOwned, changed }
}

/** Remove exactly what Expanse owned from a parsed settings object (consent revoke / unsync). */
export function stripRules(
  settings: Record<string, unknown>,
  owned: OwnedClaudeRules | undefined
): { settings: Record<string, unknown>; changed: boolean } {
  if (!owned || (owned.deny.length === 0 && !owned.sandbox)) return { settings, changed: false }
  const r = mergeRules(settings, NO_WORKSPACE_RULES, owned)
  return { settings: r.settings, changed: r.changed }
}

// ── The ledger: what Expanse added, per target dir ───────────────────────────────────────────────

const ledger = new Map<string, OwnedClaudeRules>()
let ledgerUserData: string | null = null

/** Bind the userData dir the ledger persists through (boot), and merge what earlier sessions left. */
export function bindClaudeRulesLedger(userDataDir: string): void {
  ledgerUserData = userDataDir
  for (const [dir, owned] of Object.entries(readOwnedRulesStore(userDataDir))) {
    if (!ledger.has(dir)) ledger.set(dir, owned)
  }
}

/** What Expanse added in `dir`, if anything. */
export function ownedRulesFor(dir: string): OwnedClaudeRules | undefined {
  return ledger.get(dir)
}

/** Record (or with an empty/undefined value, forget) what Expanse added in `dir`. Best-effort persist. */
export function setOwnedRules(dir: string, owned: OwnedClaudeRules | undefined): void {
  const keep = owned && (owned.deny.length > 0 || owned.sandbox) ? owned : undefined
  if (keep) ledger.set(dir, keep)
  else ledger.delete(dir)
  if (!ledgerUserData) return
  try {
    persistOwnedRules(ledgerUserData, dir, keep)
  } catch {
    /* best-effort: an unwritable userData must not fail the spawn-time write or the revoke */
  }
}

/** Test seam: clear the ledger and its binding. */
export function __resetClaudeRulesLedger(): void {
  ledger.clear()
  ledgerUserData = null
}

/**
 * Dev-instance profile isolation — per-checkout userData.
 *
 * Every unpackaged instance historically shared ONE Electron profile (%APPDATA%/canvas-ade — the
 * app name comes from package.json `name`): main-checkout dev, every worktree dev, AND the
 * Playwright e2e harness. Chromium takes cross-process locks on that profile (Local Storage
 * LevelDB, DIPS, caches, Network state), so a second live instance boots degraded or dies — the
 * "close ALL Expanse windows before a dev check" ritual. The app-owned JSON stores raced across
 * processes too (the recentProjects.ts cross-process hazard).
 *
 * Fix: each checkout gets its own profile under `<legacy userData>/profiles/<slug>`, where slug =
 * the checkout folder name (the same identity the dev window-title stamp uses) plus a short hash
 * of the full path (same-named checkouts in different places stay distinct). The e2e harness
 * (CANVAS_E2E) and the CANVAS_SMOKE harness get `-e2e` / `-smoke` suffixed profiles so they can
 * run while a dev window of the same checkout is open.
 *
 * Escape hatches:
 *   - CANVAS_USERDATA=<dir> → explicit profile dir (wins over everything below).
 *   - CANVAS_FRESH=1        → throwaway mkdtemp profile, deleted on quit (pure-eyeball checks;
 *                             no migration, no state).
 *
 * Packaged builds are untouched (productName profile + the single-instance lock). The voice
 * spike (CANVAS_VOICE_SPIKE) owns its own mkdtemp redirect in voiceBoot.ts — skipped here.
 *
 * MUST run at module scope BEFORE the single-instance lock (the lock is keyed on userData) and
 * before anything reads a userData path. The first boot of a new per-checkout profile migrates
 * the legacy shared root's config files in (one-time copy; Chromium profile dirs, the append-only
 * audit log, and project-thumbs stay behind — thumbs regenerate).
 */
import { basename, join, resolve } from 'path'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

export interface ProfileDecision {
  /** The profile dir to redirect userData to, or null = leave Electron's default untouched. */
  dir: string | null
  /** Checkout slug (also consumed by the per-checkout dev AppUserModelId). Null when packaged. */
  slug: string | null
  /** True for a CANVAS_FRESH throwaway profile — the caller deletes it on quit. */
  fresh: boolean
}

/**
 * Stable per-checkout identity: sanitized folder name + 6 hex chars of an FNV-1a hash of the
 * full path. Readable in the profiles/ dir AND collision-safe across same-named checkouts.
 */
export function devProfileSlug(cwd: string): string {
  const name =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'checkout'
  let h = 0x811c9dc5
  for (let i = 0; i < cwd.length; i++) {
    h ^= cwd.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${name}-${h.toString(16).padStart(8, '0').slice(0, 6)}`
}

export interface ResolveProfileInput {
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  cwd: string
  /** Electron's default userData BEFORE any redirect (%APPDATA%/canvas-ade in dev). */
  baseUserData: string
  /** mkdtemp seam for CANVAS_FRESH — injectable in tests. */
  mkdtemp?: (prefix: string) => string
}

/** Pure resolution — no fs side effects except the CANVAS_FRESH mkdtemp. */
export function resolveDevProfile(input: ResolveProfileInput): ProfileDecision {
  const { isPackaged, env, cwd, baseUserData } = input
  if (isPackaged) return { dir: null, slug: null, fresh: false }
  // The voice spike isolates itself (voiceBoot.ts mkdtemp redirect) — don't fight it.
  if (env.CANVAS_VOICE_SPIKE) return { dir: null, slug: null, fresh: false }
  const slug = devProfileSlug(cwd)
  if (env.CANVAS_USERDATA) return { dir: resolve(env.CANVAS_USERDATA), slug, fresh: false }
  if (env.CANVAS_FRESH) {
    const mk = input.mkdtemp ?? ((prefix: string): string => mkdtempSync(prefix))
    return { dir: mk(join(tmpdir(), 'expanse-fresh-')), slug, fresh: true }
  }
  const suffix = env.CANVAS_E2E ? '-e2e' : env.CANVAS_SMOKE ? '-smoke' : ''
  return { dir: join(baseUserData, 'profiles', slug + suffix), slug, fresh: false }
}

/**
 * Config files copied from the legacy shared root into a brand-new profile (one-time).
 * Deliberately NOT migrated: Chromium profile dirs (locks — the whole point), `lockfile`,
 * `mcp-audit.jsonl` (append-only forensic trail, stays with the legacy root), `project-thumbs/`
 * (regenerates on the next project snapshot).
 */
export const MIGRATED_FILES = [
  'recent-projects.json',
  'recap-consent.json',
  'hotkey-config.json',
  'llm-config.json',
  'llm-budget.json',
  'low-ram.json',
  'notifications-config.json',
  'orchestration-config.json',
  'orchestration-consent.json',
  'voice-config.json',
  'auth-tokens.json',
  'session.json',
  'entitlement.json',
  'external-mcp-dirs.json',
  'provisioned-dirs.json',
  'background-keep.json'
] as const

/**
 * Dirs copied whole. `recap/` = the session map (Resume across the migration). `voice-models/`
 * = immutable downloaded model blobs — copying keeps dictation working without a re-download
 * per checkout (one-time disk cost; models are optional so a missing dir is a no-op).
 */
export const MIGRATED_DIRS = ['recap', 'voice-models'] as const

/**
 * One-time, first-creation-only migration: the profile dir already existing means it ran (or the
 * profile was born fresh) — return [] and touch nothing. Every copy is best-effort: a locked or
 * vanishing source file is skipped, never fatal (the app must boot regardless).
 */
export function migrateLegacyProfile(legacyRoot: string, profileDir: string): string[] {
  if (existsSync(profileDir)) return []
  mkdirSync(profileDir, { recursive: true })
  const copied: string[] = []
  for (const f of MIGRATED_FILES) {
    try {
      const src = join(legacyRoot, f)
      if (existsSync(src)) {
        copyFileSync(src, join(profileDir, f))
        copied.push(f)
      }
    } catch {
      /* best-effort — skip a locked/racing source */
    }
  }
  for (const d of MIGRATED_DIRS) {
    try {
      const src = join(legacyRoot, d)
      if (existsSync(src)) {
        cpSync(src, join(profileDir, d), { recursive: true })
        copied.push(`${d}/`)
      }
    } catch {
      /* best-effort */
    }
  }
  return copied
}

/** The minimal slice of `app` this module needs — injectable in tests. */
export interface AppPathsLike {
  isPackaged: boolean
  getPath(name: 'userData'): string
  setPath(name: 'userData' | 'sessionData', value: string): void
}

/**
 * Resolve + apply: migrate a brand-new per-checkout profile from the legacy root, then redirect
 * BOTH `userData` and `sessionData` at the profile dir. sessionData only defaults to userData at
 * app init, so it is pinned explicitly — the Chromium profile (Cache, Local Storage, Network)
 * moves WITH the app stores, keeping the on-disk layout identical to the legacy root's.
 */
export function applyDevProfileIsolation(
  app: AppPathsLike,
  env: NodeJS.ProcessEnv,
  cwd: string
): ProfileDecision {
  const baseUserData = app.getPath('userData')
  const decision = resolveDevProfile({ isPackaged: app.isPackaged, env, cwd, baseUserData })
  if (!decision.dir) return decision
  if (decision.fresh) {
    mkdirSync(decision.dir, { recursive: true }) // mkdtemp already made it; harmless
  } else {
    const copied = migrateLegacyProfile(baseUserData, decision.dir)
    if (copied.length > 0) {
      console.log(
        `[profile] new profile ${decision.dir} — migrated ${copied.length} item(s) from ${baseUserData}`
      )
    }
  }
  app.setPath('userData', decision.dir)
  app.setPath('sessionData', decision.dir)
  return decision
}

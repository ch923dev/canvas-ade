/**
 * Dev-check project sandbox — a per-checkout project folder for unpackaged builds.
 *
 * `profileIsolation.ts` isolates each checkout's **userData**, but a project DOCUMENT lives inside
 * the project folder, so nothing isolated it: a dev check and the released app both opened the same
 * folder and therefore the same `<project>/.canvas/canvas.json`. A dev build's schema routinely runs
 * ahead of the released app's, and `boardSchema.toObject` stamps THIS build's
 * `schemaVersion`/`minReaderVersion` on every autosave — so one dev check would rewrite the user's
 * real project at a compat floor the released app is forbidden to read ("update the app to open
 * it"), and the second autosave rotated the poisoned doc into `.bak` too, destroying the only
 * recovery copy.
 *
 * Worse, the hazard was actively SEEDED: `profileIsolation.MIGRATED_FILES` used to copy
 * `recent-projects.json` into every new per-checkout profile, so the user's real project sat at the
 * top of the dev WelcomeScreen in every worktree. That entry is no longer migrated, and this module
 * provisions an EMPTY sandbox project and makes it the recent instead — so the obvious click in a
 * dev build is the safe one.
 *
 * This is the ergonomic half. The load-bearing half is `projectStore.assertNoSchemaFloorRaise`,
 * which fail-closes even if a dev build is pointed at a real project by hand.
 *
 * Sandbox location — beside the existing `profiles/` dir, under the PRE-redirect userData so every
 * checkout's sandbox lives in one sweepable place:
 *
 *     <baseUserData>/devcheck-projects/<slug>/       (Windows: %APPDATA%\canvas-ade\...)
 *       └─ .canvas/canvas.json                       fresh empty doc @ this build's SCHEMA_VERSION
 *
 * Escape hatch: `CANVAS_DEV_PROJECT=<dir>` puts the sandbox somewhere else (or points it at a
 * scratch project you already have).
 */
import { join, resolve } from 'path'
import { createProject, projectName, setSchemaFloorGuard } from './projectStore'
import { devProfileSlug } from './profileIsolation'
import { touchRecent } from './recentProjects'

/** Folder under the pre-redirect userData that holds every checkout's sandbox project. */
export const SANDBOX_ROOT = 'devcheck-projects'

export interface ResolveSandboxInput {
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  cwd: string
  /** Electron's default userData BEFORE profileIsolation's redirect (%APPDATA%/canvas-ade in dev). */
  baseUserData: string
}

export interface SandboxDecision {
  /** The sandbox project dir, or null = this instance gets no sandbox. */
  dir: string | null
  /** Checkout slug (shared with the dev profile + window-title stamp). Null when not applicable. */
  slug: string | null
}

/**
 * Pure resolution — no fs side effects.
 *
 * Skipped for packaged builds (they open real projects; that is the product) and for the harnesses
 * that already own their isolation: `CANVAS_E2E` and `CANVAS_SMOKE` drive project opens explicitly
 * from their specs, and `CANVAS_VOICE_SPIKE` runs its own redirect (voiceBoot.ts). `CANVAS_FRESH`
 * is deliberately NOT skipped: it mints a throwaway *profile*, and a throwaway profile with no
 * recents is exactly the case that most needs a safe project one click away.
 */
export function resolveDevSandbox(input: ResolveSandboxInput): SandboxDecision {
  const { isPackaged, env, cwd, baseUserData } = input
  if (isPackaged) return { dir: null, slug: null }
  if (env.CANVAS_E2E || env.CANVAS_SMOKE || env.CANVAS_VOICE_SPIKE) return { dir: null, slug: null }
  const slug = devProfileSlug(cwd)
  if (env.CANVAS_DEV_PROJECT) return { dir: resolve(env.CANVAS_DEV_PROJECT), slug }
  return { dir: join(baseUserData, SANDBOX_ROOT, slug), slug }
}

/** The minimal slice of Electron's `app` this module needs — injectable in tests. */
export interface AppContainmentLike {
  isPackaged: boolean
  getPath(name: 'userData'): string
}

/**
 * Arm both halves of dev-check schema containment. Called ONCE at module scope in `index.ts`,
 * BEFORE `applyDevProfileIsolation` — the sandbox path is derived from the PRE-redirect userData,
 * and the floor guard must be armed before any save path can run.
 *
 * Factored out of index.ts (the voice.ts / swarm.ts precedent) to keep it under the max-lines
 * ratchet, and because the guard and the sandbox are two halves of one decision: the guard makes
 * writing a released project impossible, the sandbox gives the dev check somewhere to go instead.
 * Returns the sandbox decision to hand to `provisionDevSandbox` once `whenReady` has userData.
 */
export function applyDevCheckContainment(
  app: AppContainmentLike,
  env: NodeJS.ProcessEnv,
  cwd: string
): SandboxDecision {
  // An UNPACKAGED build may read and migrate a project the released app wrote, but must never
  // PERSIST the raised floor. Packaged builds are the ones whose schema is actually released, so
  // they keep raising it. CANVAS_ALLOW_SCHEMA_RAISE=1 overrides for a deliberate migration test.
  //
  // DELIBERATELY asymmetric with resolveDevSandbox's env skips below: those three harnesses are
  // exempt from the SANDBOX (provisioning a project + rewriting recents would fight specs that
  // drive their own opens), but NOT from the guard. A fail-closed invariant earns its keep by
  // having no situational exemptions, and it costs the harnesses nothing — they run in `-e2e` /
  // `-smoke` suffixed profiles (profileIsolation.ts) against fresh temp fixture dirs, and a fresh
  // dir has no prior doc, so the guard is a no-op by construction. It only bites a fixture that
  // deliberately seeds a STALE schema to exercise migration — which is precisely the case
  // CANVAS_ALLOW_SCHEMA_RAISE=1 exists for; set it in that spec's env.
  setSchemaFloorGuard(!app.isPackaged && !env.CANVAS_ALLOW_SCHEMA_RAISE)
  return resolveDevSandbox({
    isPackaged: app.isPackaged,
    env,
    cwd,
    baseUserData: app.getPath('userData')
  })
}

/**
 * Create the sandbox project if absent and make it the most-recent entry.
 *
 * Idempotent: `createProject` reuses an existing `canvas.json` and only writes a fresh empty doc
 * when there is none, so re-running this on every boot never clobbers boards you left in the
 * sandbox. The fresh write has no prior file, so the schema-floor guard is a no-op by construction
 * — the sandbox is free to sit at whatever version this build writes.
 *
 * `userDataDir` is the POST-redirect profile dir (that is where `recent-projects.json` lives),
 * while the sandbox dir itself is derived from the PRE-redirect base — the two are deliberately
 * different roots.
 *
 * Best-effort: a permission/disk failure must never block boot, exactly like
 * `scaffoldProjectMemory`. Returns the provisioned dir, or null when skipped or failed.
 */
export async function provisionDevSandbox(
  decision: SandboxDecision,
  userDataDir: string,
  now: number
): Promise<string | null> {
  const dir = decision.dir
  if (!dir) return null
  try {
    const created = await createProject(dir, projectName(dir), {})
    if (!created.ok) {
      console.warn('[devSandbox] could not provision the dev-check sandbox:', created.error)
      return null
    }
    // Front of the MRU so the dev WelcomeScreen offers the sandbox first. touchRecent keeps every
    // other entry, so a dev profile that already carries real projects still lists them — the
    // floor guard is what makes those harmless, not their absence.
    await touchRecent(userDataDir, dir, created.name, now)
    return dir
  } catch (err) {
    console.warn('[devSandbox] sandbox provisioning failed (non-fatal)', err)
    return null
  }
}

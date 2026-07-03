import { basename } from 'node:path'

/**
 * Background-project session registry (Background Project Sessions epic, Phase 1).
 *
 * One project is ACTIVE (rendered, `projectStore.currentDir`); N others may be RESIDENT in the
 * background — their PTYs parked-but-running (pty.ts park/adopt) and their offscreen preview
 * windows alive-but-frozen (previewOsr.ts background/foreground). This registry is the single
 * source of truth for WHICH projects are backgrounded; the pty/previewOsr modules own the
 * resources themselves. Factory-injected deps (createMemoryEngine style) keep it unit-testable
 * without the electron/node-pty runtime — index.ts wires the real functions.
 *
 * Lifetime is the APP RUN only (locked scope decision): quit routes through disposeAllPtys /
 * disposeAllOsr, which kill background resources too — the registry is never persisted.
 */

/** What the ProjectSwitcher lists per backgrounded project (badges + Close). */
export interface BackgroundProjectInfo {
  dir: string
  name: string
  terminalsRunning: number
  previews: number
  backgroundedAt: number
}

export interface ProjectSessionDeps {
  /** pty.reapUndoParks — reap `dir`'s undo-parked (deleted-board) sessions BEFORE the park:
   *  the switch's store replace wipes the undo rail, so they can never be adopted again (R5). */
  reapUndoParks(dir: string): Promise<void>
  /** pty.parkProjectSessions — park `dir`'s live sessions (no TTL). Returns count parked. */
  parkPtys(dir: string): number
  /** pty.disposeProjectPtys — kill `dir`'s sessions, live + parked. */
  disposePtys(dir: string): Promise<void>
  /** pty.countProjectSessions — running terminals owned by `dir`. */
  countPtys(dir: string): { running: number }
  /** previewOsr.backgroundProjectOsr — freeze/throttle/mute `dir`'s windows. Returns count. */
  backgroundOsr(dir: string): number
  /** previewOsr.foregroundProjectOsr — un-throttle `dir`'s windows on switch-back. */
  foregroundOsr(dir: string): number
  /** previewOsr.disposeProjectOsr — destroy `dir`'s windows. */
  disposeOsr(dir: string): void
  /** previewOsr.countProjectOsr — open preview windows owned by `dir`. */
  countOsr(dir: string): number
  /** Clock (injectable for tests). */
  now(): number
  /**
   * Phase 4: the persisted forever-keep dirs (the dialog's opt-in checkbox). Lives in
   * userData — app/machine preference, NEVER the project folder (canvas.json is git-shared).
   * Injectable so tests need no fs; index.ts wires a JSON file. Load errors → [].
   */
  loadForeverKeeps(): string[]
  saveForeverKeeps(dirs: string[]): void
}

export interface ProjectSessions {
  /** Park + freeze everything `dir` owns and register it as backgrounded. */
  backgroundProject(dir: string): Promise<{ terminals: number; previews: number }>
  /**
   * Un-register `dir` and un-throttle its previews. Called on EVERY project open (idempotent
   * no-op for a never-backgrounded dir) so a switch-back clears the backgrounded flag before
   * any board mounts — the OSR close-suppression must flip off for normal foreground deletes.
   */
  foregroundProject(dir: string): void
  /** Kill everything a BACKGROUNDED `dir` owns. False when `dir` is not registered — the
   *  IPC layer must never dispose an arbitrary renderer-supplied path. Also forgets the
   *  dir's keep policy (Phase 4: closing IS the single policy-reset gesture). */
  closeBackgroundProject(dir: string): Promise<boolean>
  isBackgroundProject(dir: string): boolean
  listBackgroundProjects(): BackgroundProjectInfo[]
  /** Registry size (resource-cap checks live at the Phase-4 dialog). */
  backgroundCount(): number
  /** Live resource counts for `dir` (the ask-on-switch dialog body). */
  liveCounts(dir: string): { terminals: number; previews: number }
  /**
   * Phase 4 switch policy. 'ask' (default) → the renderer shows the ask-on-switch dialog;
   * 'keep' → silent background. 'keep' is set by the dialog's Keep pick: session-scoped by
   * default (dies with the app run, like the sessions), plus optionally PERSISTED (the
   * forever checkbox → userData via the injected store). Reset paths: forgetKeepPolicy (the
   * ∞ badge), closeBackgroundProject / the active-close (closing the project).
   */
  getSwitchPolicy(dir: string): 'ask' | 'keep'
  setKeepPolicy(dir: string, forever: boolean): void
  /** Clear `dir`'s session AND forever keep. Returns whether anything was cleared. */
  forgetKeepPolicy(dir: string): boolean
  /** Dirs with the PERSISTED forever flag (the ∞ badge on switcher rows / dock cards). */
  keepForeverDirs(): string[]
}

export function createProjectSessions(deps: ProjectSessionDeps): ProjectSessions {
  const registry = new Map<string, { name: string; backgroundedAt: number }>()
  // Phase 4 keep policies. Session keeps die with the run (never persisted); forever keeps
  // hydrate from + write through the injected userData store. A dir is 'keep' if EITHER holds.
  // Hydration is LAZY (first policy access) — the factory runs at module scope, before the
  // injected store's backing path (app.getPath) is necessarily ready.
  const sessionKeeps = new Set<string>()
  let foreverKeeps: Set<string> | null = null
  const forever = (): Set<string> => {
    if (!foreverKeeps) {
      try {
        foreverKeeps = new Set(deps.loadForeverKeeps())
      } catch {
        foreverKeeps = new Set()
      }
    }
    return foreverKeeps
  }
  const persistForever = (): void => {
    try {
      deps.saveForeverKeeps([...forever()])
    } catch {
      /* best-effort — a failed write degrades to session-scoped behavior */
    }
  }
  const forgetPolicy = (dir: string): boolean => {
    const hadSession = sessionKeeps.delete(dir)
    const hadForever = forever().delete(dir)
    if (hadForever) persistForever()
    return hadSession || hadForever
  }

  return {
    async backgroundProject(dir) {
      // R5 preamble: deleted boards' undo-parks die NOW (their undo rail dies with the switch's
      // store replace) — never awaited-after: a reap racing the park could misclassify entries.
      await deps.reapUndoParks(dir).catch(() => undefined)
      const terminals = deps.parkPtys(dir)
      const previews = deps.backgroundOsr(dir)
      registry.set(dir, { name: basename(dir), backgroundedAt: deps.now() })
      return { terminals, previews }
    },

    foregroundProject(dir) {
      registry.delete(dir)
      deps.foregroundOsr(dir)
    },

    async closeBackgroundProject(dir) {
      if (!registry.has(dir)) return false
      registry.delete(dir)
      forgetPolicy(dir) // closing IS the policy reset — the next open+switch asks again
      deps.disposeOsr(dir)
      await deps.disposePtys(dir)
      return true
    },

    isBackgroundProject(dir) {
      return registry.has(dir)
    },

    listBackgroundProjects() {
      return [...registry.entries()].map(([dir, r]) => ({
        dir,
        name: r.name,
        backgroundedAt: r.backgroundedAt,
        terminalsRunning: deps.countPtys(dir).running,
        previews: deps.countOsr(dir)
      }))
    },

    backgroundCount() {
      return registry.size
    },

    liveCounts(dir) {
      return { terminals: deps.countPtys(dir).running, previews: deps.countOsr(dir) }
    },

    getSwitchPolicy(dir) {
      return sessionKeeps.has(dir) || forever().has(dir) ? 'keep' : 'ask'
    },

    setKeepPolicy(dir, keepForever) {
      sessionKeeps.add(dir)
      if (keepForever && !forever().has(dir)) {
        forever().add(dir)
        persistForever()
      }
    },

    forgetKeepPolicy(dir) {
      return forgetPolicy(dir)
    },

    keepForeverDirs() {
      return [...forever()]
    }
  }
}

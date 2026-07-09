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
   * C1: max background projects to keep resident. A GETTER (not a constant) so Low-RAM mode can
   * lower it live without rebuilding the registry (index.ts wires the config read; default 3).
   * Backgrounding past this auto-closes the LONGEST-backgrounded resident.
   */
  maxBackground(): number
  /** C1: idle TTL (ms) for a background park — a resident idle (backgrounded, never switched
   *  back to) longer than this is reaped by the sweep. A getter so Low-RAM can shorten it live. */
  idleTtlMs(): number
  /**
   * C1: flush `dir`'s background terminal ring tails to their snapshot sidecar BEFORE its
   * sessions are disposed (pty.persistProjectRingTails). disposeProjectPtys does NOT flush tails
   * and the renderer flush covers only the ACTIVE project's xterms, so without this a cap/TTL/
   * manual close of a BACKGROUNDED project silently loses its parked terminals' post-park output.
   */
  persistRingTails(dir: string): void
  /**
   * Phase 4: the persisted forever-keep dirs (the dialog's opt-in checkbox). Lives in
   * userData — app/machine preference, NEVER the project folder (canvas.json is git-shared).
   * Injectable so tests need no fs; index.ts wires a JSON file. Load errors → [].
   */
  loadForeverKeeps(): string[]
  saveForeverKeeps(dirs: string[]): void
}

export interface ProjectSessions {
  /**
   * Park + freeze everything `dir` owns and register it as backgrounded. C1: enforces the
   * `maxBackground` cap AFTER registering — auto-closing the longest-backgrounded OTHER
   * resident(s) via the scoped close. `evicted` is the dirs auto-closed (usually [] or one) so
   * the caller can toast "closed X to free memory".
   */
  backgroundProject(
    dir: string
  ): Promise<{ terminals: number; previews: number; evicted: string[] }>
  /**
   * C1: reap background projects idle (backgrounded, never switched back to) longer than the
   * TTL. `protectedDirs` — the ACTIVE project + any pending switch target — are never reaped.
   * Returns the dirs closed. Safe on an interval; a no-op when nothing is stale. Uses the SAME
   * scoped close (ring-tail flush → disposeOsr → disposePtys) so no resident's output is lost.
   */
  reapIdle(protectedDirs: Iterable<string>): Promise<string[]>
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

  // C1: the ONE scoped close, shared by the manual close, the cap eviction, and the TTL reap.
  // Registry-guarded (never disposes an unregistered dir) and dir-scoped (disposeOsr/disposePtys
  // touch only `dir` — closing project B can never reap resident project A). Flushes the ring
  // tails BEFORE disposePtys so a backgrounded project's parked terminal output is never lost.
  // `resetPolicy`: a MANUAL close IS the single policy-reset gesture (forget any keep, so the next
  // open+switch asks again); a cap/TTL AUTO-evict is INVOLUNTARY, so it PRESERVES the keep policy
  // — the project re-keeps silently on the next switch-back (plan §2.5).
  const closeBg = async (dir: string, resetPolicy: boolean): Promise<boolean> => {
    if (!registry.has(dir)) return false
    registry.delete(dir)
    if (resetPolicy) forgetPolicy(dir)
    deps.persistRingTails(dir) // data-loss fix — BEFORE dispose (disposePtys does not flush tails)
    deps.disposeOsr(dir)
    await deps.disposePtys(dir)
    return true
  }

  // C1: the longest-backgrounded resident (smallest backgroundedAt), excluding `exclude` (the
  // just-backgrounded dir — never evict the one the user just switched away from). Mirrors
  // previewOsr.pickOsrEvictions' oldest-first ordering so H4's OSR trim and C1 agree.
  const pickLongestBackgrounded = (exclude: string): string | null => {
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [dir, r] of registry) {
      if (dir === exclude) continue
      if (r.backgroundedAt < oldestAt) {
        oldestAt = r.backgroundedAt
        oldest = dir
      }
    }
    return oldest
  }

  // C1: after a background push the resident set over the budget, close the longest-backgrounded
  // OTHER resident(s). Loops so a live cap DROP (Low-RAM lowering maxBackground while several are
  // resident) collapses in one call; never evicts `justAddedDir` (pickLongestBackgrounded excludes
  // it), so the just-kept project always survives even at cap 1.
  const enforceCap = async (justAddedDir: string): Promise<string[]> => {
    const evicted: string[] = []
    const max = Math.max(1, deps.maxBackground())
    while (registry.size > max) {
      const victim = pickLongestBackgrounded(justAddedDir)
      if (!victim) break
      if (await closeBg(victim, false)) evicted.push(victim) // involuntary — preserve keep policy
    }
    return evicted
  }

  return {
    async backgroundProject(dir) {
      // R5 preamble: deleted boards' undo-parks die NOW (their undo rail dies with the switch's
      // store replace) — never awaited-after: a reap racing the park could misclassify entries.
      await deps.reapUndoParks(dir).catch(() => undefined)
      const terminals = deps.parkPtys(dir)
      const previews = deps.backgroundOsr(dir)
      registry.set(dir, { name: basename(dir), backgroundedAt: deps.now() })
      // C1: enforce the cap AFTER registering `dir` (so it counts + is protected from its own
      // eviction). Auto-closes the longest-backgrounded OTHER resident(s) via the scoped close.
      const evicted = await enforceCap(dir)
      return { terminals, previews, evicted }
    },

    foregroundProject(dir) {
      registry.delete(dir)
      deps.foregroundOsr(dir)
    },

    closeBackgroundProject(dir) {
      return closeBg(dir, true) // manual close resets the keep policy
    },

    async reapIdle(protectedDirs) {
      const guarded = new Set(protectedDirs)
      const ttl = deps.idleTtlMs()
      const now = deps.now()
      // Snapshot the stale set first (closeBg mutates the registry mid-iteration). "Idle" = time
      // since backgrounded with no switch-back (foregroundProject deletes the entry, so
      // backgroundedAt IS the idle clock).
      const stale = [...registry.entries()]
        .filter(([dir, r]) => !guarded.has(dir) && now - r.backgroundedAt > ttl)
        .map(([dir]) => dir)
      const closed: string[] = []
      for (const dir of stale) {
        if (await closeBg(dir, false)) closed.push(dir) // involuntary — preserve keep policy
      }
      return closed
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

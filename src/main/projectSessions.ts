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
 *
 * Busy-aware eviction (2026-07-16): the cap + idle-TTL machinery no longer runs on wall-clock
 * alone. A resident is WORKING when its PTYs produced output recently (deps.activityAt, the
 * OUTPUT_BUSY_WINDOW_MS window) or its process tree is accruing CPU (deps.isBusy — the
 * bgBusyProbe verdict, which catches silent workers like an agent mid-e2e). Working residents
 * are never idle-reaped and never cap-evicted; fresh output also RESETS the idle clock, so the
 * TTL only ever fires on genuinely-abandoned residents. The reap itself is two-strike: an idle
 * resident is WARNED (returned to the sweep for a toast/OS notification) and closed only if
 * still idle a grace period later — the net for zero-CPU blocking waits the probe can't see.
 */

/** What the ProjectSwitcher lists per backgrounded project (badges + Close). */
export interface BackgroundProjectInfo {
  dir: string
  name: string
  terminalsRunning: number
  previews: number
  backgroundedAt: number
}

/** PTY output within this window counts a resident as WORKING (protects a streaming agent even
 *  before the CPU probe has two samples for a delta). */
export const OUTPUT_BUSY_WINDOW_MS = 30_000

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
   * Backgrounding past this auto-closes the LONGEST-backgrounded IDLE resident — a WORKING
   * resident is never the victim; when every other resident is working, the set temporarily
   * exceeds the cap (`deferred`) and the sweep collapses it once someone goes idle.
   */
  maxBackground(): number
  /** C1: idle TTL (ms) for a background park — a resident idle (no switch-back AND no PTY
   *  activity) longer than this is reaped by the sweep. A getter so Low-RAM can shorten it. */
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
  /** Busy-aware eviction: most recent PTY output for `dir` (pty.projectActivityAt). 0 = never —
   *  a 0 is NEVER "recent" (the working check special-cases it), whatever the clock reads. */
  activityAt(dir: string): number
  /** Busy-aware eviction: the CPU-probe verdict for `dir` (bgBusyProbe, refreshed per sweep). */
  isBusy(dir: string): boolean
  /** Two-strike grace between the idle WARNING and the close. <= 0 disables the warning phase
   *  (immediate close once past the TTL — what most unit tests use). */
  graceMs(): number
}

/** One sweep's outcome (reapIdle): what closed, what got its first-strike warning, and which
 *  over-cap residents the deferred cap-eviction retry collapsed (idle ones only). */
export interface ReapResult {
  closed: string[]
  warned: { dir: string; closesInMs: number }[]
  capEvicted: string[]
}

export interface ProjectSessions {
  /**
   * Park + freeze everything `dir` owns and register it as backgrounded. C1: enforces the
   * `maxBackground` cap AFTER registering — auto-closing the longest-backgrounded IDLE other
   * resident(s) via the scoped close. `evicted` is the dirs auto-closed; `deferred` counts
   * residents held ABOVE the cap because every candidate was working (the sweep retries).
   */
  backgroundProject(
    dir: string
  ): Promise<{ terminals: number; previews: number; evicted: string[]; deferred: number }>
  /**
   * C1: the sweep tick. Reaps residents idle past the TTL — where idle means no PTY activity
   * (the activity clock, not just backgroundedAt), not CPU-busy, not forever-kept, and not in
   * `protectedDirs` (the ACTIVE project + any pending switch target). Two-strike when graceMs
   * > 0: first pass returns the dir in `warned`, the close lands only if it is STILL idle a
   * grace later. Also collapses an over-cap resident set (idle victims only — the deferred
   * cap-eviction retry). Uses the SAME scoped close (ring-tail flush → disposeOsr →
   * disposePtys) everywhere so no resident's output is lost.
   */
  reapIdle(protectedDirs: Iterable<string>): Promise<ReapResult>
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
  // Two-strike reap state: dir → epoch ms of its first-strike warning. Cleared whenever the dir
  // stops qualifying (goes busy / gets activity / foregrounds / closes) so a survivor that goes
  // idle AGAIN gets a fresh warning, never a stale instant close.
  const pendingReap = new Map<string, number>()
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

  // Busy-aware eviction: is `dir` WORKING right now? CPU-probe verdict OR recent PTY output.
  // activityAt 0 = "never produced output" and is never recent (test clocks start near 0).
  const isWorking = (dir: string): boolean => {
    if (deps.isBusy(dir)) return true
    const at = deps.activityAt(dir)
    return at > 0 && deps.now() - at < OUTPUT_BUSY_WINDOW_MS
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
    pendingReap.delete(dir)
    if (resetPolicy) forgetPolicy(dir)
    deps.persistRingTails(dir) // data-loss fix — BEFORE dispose (disposePtys does not flush tails)
    deps.disposeOsr(dir)
    await deps.disposePtys(dir)
    return true
  }

  // C1: the longest-backgrounded resident (smallest backgroundedAt), excluding `exclude` (the
  // just-backgrounded dir — never evict the one the user just switched away from) and — busy-aware
  // eviction — any WORKING resident: a running agent is never the cap victim. Mirrors
  // previewOsr.pickOsrEvictions' oldest-first ordering so H4's OSR trim and C1 agree.
  // `backgroundedBefore` (sweep cap-retry only): a candidate must have been resident since before
  // this stamp — protects the FRESHLY-kept project (there is no `justAddedDir` at sweep time) from
  // being collapsed seconds after the user chose Keep.
  const pickOldestIdle = (
    exclude: string | null,
    excludeSet?: Set<string>,
    backgroundedBefore = Infinity
  ): string | null => {
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [dir, r] of registry) {
      if (dir === exclude || excludeSet?.has(dir)) continue
      if (r.backgroundedAt > backgroundedBefore) continue
      if (isWorking(dir)) continue
      if (r.backgroundedAt < oldestAt) {
        oldestAt = r.backgroundedAt
        oldest = dir
      }
    }
    return oldest
  }

  // C1: after a background push the resident set over the budget, close the longest-backgrounded
  // IDLE other resident(s). Loops so a live cap DROP (Low-RAM lowering maxBackground while several
  // are resident) collapses in one call; never evicts `justAddedDir` (pickOldestIdle excludes it),
  // so the just-kept project always survives even at cap 1. When every candidate is WORKING the
  // loop stops short: the overflow is reported as `deferred` (the sweep's cap retry collapses it
  // once someone goes idle) — a busy agent is never silently killed for memory.
  const enforceCap = async (
    justAddedDir: string
  ): Promise<{ evicted: string[]; deferred: number }> => {
    const evicted: string[] = []
    const max = Math.max(1, deps.maxBackground())
    while (registry.size > max) {
      const victim = pickOldestIdle(justAddedDir)
      if (!victim) break // every other resident is working — defer, never kill busy
      if (await closeBg(victim, false))
        evicted.push(victim) // involuntary — preserve keep policy
      else break
    }
    return { evicted, deferred: Math.max(0, registry.size - max) }
  }

  return {
    async backgroundProject(dir) {
      // R5 preamble: deleted boards' undo-parks die NOW (their undo rail dies with the switch's
      // store replace) — never awaited-after: a reap racing the park could misclassify entries.
      await deps.reapUndoParks(dir).catch(() => undefined)
      const terminals = deps.parkPtys(dir)
      const previews = deps.backgroundOsr(dir)
      registry.set(dir, { name: basename(dir), backgroundedAt: deps.now() })
      pendingReap.delete(dir) // a fresh background is never mid-strike
      // C1: enforce the cap AFTER registering `dir` (so it counts + is protected from its own
      // eviction). Auto-closes the longest-backgrounded IDLE other resident(s).
      const { evicted, deferred } = await enforceCap(dir)
      return { terminals, previews, evicted, deferred }
    },

    foregroundProject(dir) {
      registry.delete(dir)
      pendingReap.delete(dir)
      deps.foregroundOsr(dir)
    },

    closeBackgroundProject(dir) {
      return closeBg(dir, true) // manual close resets the keep policy
    },

    async reapIdle(protectedDirs) {
      const guarded = new Set(protectedDirs)
      const ttl = deps.idleTtlMs()
      const grace = deps.graceMs()
      const now = deps.now()
      const closed: string[] = []
      const warned: { dir: string; closesInMs: number }[] = []
      const keepForever = forever()
      // Snapshot the entries first (closeBg mutates the registry mid-iteration). "Idle" = time
      // since the LAST of {backgrounded, PTY output} — activity RESETS the clock — with a busy
      // (CPU) resident never idle at all. ∞ forever-keeps are exempt from the TTL entirely (the
      // user explicitly said keep; only cap pressure may still evict them, and only when idle).
      for (const [dir, r] of [...registry.entries()]) {
        if (guarded.has(dir) || keepForever.has(dir) || isWorking(dir)) {
          pendingReap.delete(dir)
          continue
        }
        const idleSince = Math.max(r.backgroundedAt, deps.activityAt(dir))
        if (now - idleSince <= ttl) {
          pendingReap.delete(dir)
          continue
        }
        if (grace > 0) {
          const warnedAt = pendingReap.get(dir)
          if (warnedAt === undefined) {
            // Strike 1: warn only. The sweep surfaces this (toast + OS notification) so the
            // zero-CPU blocking wait the probe can't see still gets a human-visible net.
            pendingReap.set(dir, now)
            warned.push({ dir, closesInMs: grace })
            continue
          }
          if (now - warnedAt < grace) continue // between strikes — silent
        }
        if (await closeBg(dir, false)) closed.push(dir) // involuntary — preserve keep policy
      }
      // Deferred cap-eviction retry: collapse an over-cap resident set (an all-busy defer at
      // background time) — IDLE victims only (a defer must never turn into a busy kill here),
      // and only residents older than the grace window (the freshly-kept project is protected).
      const capEvicted: string[] = []
      const max = Math.max(1, deps.maxBackground())
      while (registry.size > max) {
        const victim = pickOldestIdle(null, guarded, now - Math.max(0, grace))
        if (!victim) break
        if (await closeBg(victim, false)) capEvicted.push(victim)
        else break
      }
      return { closed, warned, capEvicted }
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

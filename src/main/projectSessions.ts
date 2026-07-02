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
}

export interface ProjectSessions {
  /** Park + freeze everything `dir` owns and register it as backgrounded. */
  backgroundProject(dir: string): { terminals: number; previews: number }
  /**
   * Un-register `dir` and un-throttle its previews. Called on EVERY project open (idempotent
   * no-op for a never-backgrounded dir) so a switch-back clears the backgrounded flag before
   * any board mounts — the OSR close-suppression must flip off for normal foreground deletes.
   */
  foregroundProject(dir: string): void
  /** Kill everything a BACKGROUNDED `dir` owns. False when `dir` is not registered — the
   *  IPC layer must never dispose an arbitrary renderer-supplied path. */
  closeBackgroundProject(dir: string): Promise<boolean>
  isBackgroundProject(dir: string): boolean
  listBackgroundProjects(): BackgroundProjectInfo[]
  /** Registry size (resource-cap checks live at the Phase-4 dialog). */
  backgroundCount(): number
}

export function createProjectSessions(deps: ProjectSessionDeps): ProjectSessions {
  const registry = new Map<string, { name: string; backgroundedAt: number }>()

  return {
    backgroundProject(dir) {
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
    }
  }
}

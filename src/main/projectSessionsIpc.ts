import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import type { BackgroundProjectInfo, ProjectSessions } from './projectSessions'

/**
 * Background project sessions — the renderer-facing control plane (Phase 2; Phase 4 removed
 * the EXPANSE_BG_SESSIONS flag — keep-running is the shipped behavior, mediated by the
 * ask-on-switch dialog + per-project keep policy).
 *
 * `project:background` backgrounds the ACTIVE project (dir resolved MAIN-side via
 * `getCurrentDir` — never a renderer-supplied path); `project:closeBackground` kills a
 * BACKGROUNDED project's resources (the registry membership check inside
 * `closeBackgroundProject` is what stops a compromised renderer from disposing an arbitrary
 * dir); `project:closeActive` is the scoped "Close project" sibling of the old dispose-all
 * teardown, so closing the active project never reaps other residents' sessions.
 *
 * Phase 4 policy plane: `project:askOnSwitchInfo` (the outgoing dialog decision — ACTIVE-dir
 * policy + live counts in one round trip), `project:setKeepPolicy` (Keep pick; ACTIVE dir,
 * MAIN-resolved), `project:forgetKeepPolicy` (the ∞ badge — clearing a policy is never
 * destructive, so an arbitrary dir string is acceptable), `project:keepForeverDirs` (∞
 * badges). Both close paths forget the closed dir's policy (the single reset gesture).
 */
export interface ProjectSessionsIpcDeps {
  sessions: ProjectSessions
  getCurrentDir(): string | null
  /** pty.disposeProjectPtys — scoped kill for the ACTIVE-project close path. */
  disposeProjectPtys(dir: string): Promise<void>
  /** previewOsrBackground.disposeProjectOsr — scoped window destroy for the same path. */
  disposeProjectOsr(dir: string): void
}

export interface BackgroundResult {
  ok: boolean
  terminals: number
  previews: number
}

/** The one-round-trip payload behind the renderer's switch-away decision (Phase 4). */
export interface AskOnSwitchInfo {
  dir: string
  policy: 'ask' | 'keep'
  terminals: number
  previews: number
}

export function registerProjectSessionsHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ProjectSessionsIpcDeps
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipc.handle('project:askOnSwitchInfo', (e): AskOnSwitchInfo | null => {
    if (guard(e)) return null
    const dir = deps.getCurrentDir()
    if (!dir) return null
    const { terminals, previews } = deps.sessions.liveCounts(dir)
    return { dir, policy: deps.sessions.getSwitchPolicy(dir), terminals, previews }
  })

  // Keep pick for the ACTIVE project (dir MAIN-resolved — the renderer never names it).
  ipc.handle('project:setKeepPolicy', (e, forever: unknown): boolean => {
    if (guard(e)) return false
    const dir = deps.getCurrentDir()
    if (!dir) return false
    deps.sessions.setKeepPolicy(dir, forever === true)
    return true
  })

  // The ∞ badge. Renderer-supplied dir is acceptable here: forgetting a policy is never
  // destructive (no process/window is touched), and it no-ops for an unknown dir.
  ipc.handle('project:forgetKeepPolicy', (e, dir: string): boolean => {
    if (guard(e)) return false
    if (typeof dir !== 'string' || dir.length === 0) return false
    return deps.sessions.forgetKeepPolicy(dir)
  })

  ipc.handle('project:keepForeverDirs', (e): string[] => {
    if (guard(e)) return []
    return deps.sessions.keepForeverDirs()
  })

  ipc.handle('project:background', async (e): Promise<BackgroundResult> => {
    if (guard(e)) return { ok: false, terminals: 0, previews: 0 }
    const dir = deps.getCurrentDir()
    if (!dir) return { ok: false, terminals: 0, previews: 0 }
    const { terminals, previews } = await deps.sessions.backgroundProject(dir)
    return { ok: true, terminals, previews }
  })

  ipc.handle('project:listBackground', (e): BackgroundProjectInfo[] => {
    if (guard(e)) return []
    return deps.sessions.listBackgroundProjects()
  })

  ipc.handle('project:closeBackground', async (e, dir: string): Promise<boolean> => {
    if (guard(e)) return false
    if (typeof dir !== 'string' || dir.length === 0) return false
    // Registry-validated inside: an unregistered dir (e.g. an arbitrary renderer path) is refused.
    return deps.sessions.closeBackgroundProject(dir)
  })

  // The scoped sibling of the legacy dispose-all switch teardown: kill ONLY what the active
  // project owns. Used by the "Stop everything" switch path; quit keeps disposeAll*.
  ipc.handle('project:closeActive', async (e): Promise<boolean> => {
    if (guard(e)) return false
    const dir = deps.getCurrentDir()
    if (!dir) return false
    deps.sessions.forgetKeepPolicy(dir) // closing resets the policy (Phase 4 single gesture)
    deps.disposeProjectOsr(dir)
    await deps.disposeProjectPtys(dir)
    return true
  })
}

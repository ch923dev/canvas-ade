import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import type { BackgroundProjectInfo, ProjectSessions } from './projectSessions'

/**
 * Background project sessions — the renderer-facing control plane (Phase 2).
 *
 * `project:background` backgrounds the ACTIVE project (dir resolved MAIN-side via
 * `getCurrentDir` — never a renderer-supplied path); `project:closeBackground` kills a
 * BACKGROUNDED project's resources (the registry membership check inside
 * `closeBackgroundProject` is what stops a compromised renderer from disposing an arbitrary
 * dir); `project:closeActive` is the scoped "Close project" sibling of the old dispose-all
 * teardown, so closing the active project never reaps other residents' sessions.
 *
 * `project:bgSessionsEnabled` exposes the EXPANSE_BG_SESSIONS dev flag: it gates only the
 * renderer's DEFAULT switch behavior (Phase 2 ships dark). The handlers themselves are not
 * flag-gated — an explicit invocation (the e2e harness) backgrounds only the active project,
 * which is side-effect-equivalent to not switching, and every handler stays frame-guarded.
 */
export interface ProjectSessionsIpcDeps {
  sessions: ProjectSessions
  getCurrentDir(): string | null
  /** pty.disposeProjectPtys — scoped kill for the ACTIVE-project close path. */
  disposeProjectPtys(dir: string): Promise<void>
  /** previewOsrBackground.disposeProjectOsr — scoped window destroy for the same path. */
  disposeProjectOsr(dir: string): void
  /** The EXPANSE_BG_SESSIONS dev flag (injectable for tests). */
  enabled(): boolean
}

export interface BackgroundResult {
  ok: boolean
  terminals: number
  previews: number
}

export function registerProjectSessionsHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ProjectSessionsIpcDeps
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipc.handle('project:bgSessionsEnabled', (e): boolean => {
    if (guard(e)) return false
    return deps.enabled()
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
  // project owns. Used by the flag-on "Close project" switch path; quit keeps disposeAll*.
  ipc.handle('project:closeActive', async (e): Promise<boolean> => {
    if (guard(e)) return false
    const dir = deps.getCurrentDir()
    if (!dir) return false
    deps.disposeProjectOsr(dir)
    await deps.disposeProjectPtys(dir)
    return true
  })
}

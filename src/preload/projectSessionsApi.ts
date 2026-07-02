import { ipcRenderer } from 'electron'

/**
 * Background project sessions (Phase 2) — the `project.*` switch-pipeline methods, factored out
 * of preload/index.ts to stay under the max-lines ratchet (like terminalApi). Spread into the
 * `project` namespace there. Every handler is `isForeignSender` frame-guarded in MAIN
 * (projectSessionsIpc.ts).
 */

/** Mirrors main `projectSessions.BackgroundProjectInfo`. */
export interface BackgroundProjectInfo {
  dir: string
  name: string
  terminalsRunning: number
  previews: number
  backgroundedAt: number
}

export const projectSessionsApi = {
  /** The EXPANSE_BG_SESSIONS dev flag — gates the renderer's DEFAULT switch behavior only. */
  bgSessionsEnabled: (): Promise<boolean> => ipcRenderer.invoke('project:bgSessionsEnabled'),
  /** Background the ACTIVE project (dir resolved MAIN-side): park PTYs, freeze previews. */
  background: (): Promise<{ ok: boolean; terminals: number; previews: number }> =>
    ipcRenderer.invoke('project:background'),
  listBackground: (): Promise<BackgroundProjectInfo[]> =>
    ipcRenderer.invoke('project:listBackground'),
  /** Kill a BACKGROUNDED project's resources (registry-validated in MAIN). */
  closeBackground: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke('project:closeBackground', dir),
  /** Scoped close of the ACTIVE project's resources (never touches other residents). */
  closeActive: (): Promise<boolean> => ipcRenderer.invoke('project:closeActive')
}

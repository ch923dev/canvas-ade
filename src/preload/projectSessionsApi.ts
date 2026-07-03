import { ipcRenderer } from 'electron'

/**
 * Background project sessions (Phase 2 + the Phase-4 keep-policy plane) — the `project.*`
 * switch-pipeline methods, factored out of preload/index.ts to stay under the max-lines ratchet
 * (like terminalApi). Spread into the `project` namespace there. Every handler is
 * `isForeignSender` frame-guarded in MAIN (projectSessionsIpc.ts).
 */

/** Mirrors main `projectSessions.BackgroundProjectInfo`. */
export interface BackgroundProjectInfo {
  dir: string
  name: string
  terminalsRunning: number
  previews: number
  backgroundedAt: number
}

/** Mirrors main `projectSessionsIpc.AskOnSwitchInfo`. */
export interface AskOnSwitchInfo {
  dir: string
  policy: 'ask' | 'keep'
  terminals: number
  previews: number
}

export const projectSessionsApi = {
  /** ACTIVE project's switch policy + live counts (the ask-on-switch dialog decision). */
  askOnSwitchInfo: (): Promise<AskOnSwitchInfo | null> =>
    ipcRenderer.invoke('project:askOnSwitchInfo'),
  /** Remember Keep for the ACTIVE project (session-scoped; `forever` also persists to userData). */
  setKeepPolicy: (forever: boolean): Promise<boolean> =>
    ipcRenderer.invoke('project:setKeepPolicy', forever),
  /** The ∞ badge — clear a project's session + forever keep (non-destructive). */
  forgetKeepPolicy: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke('project:forgetKeepPolicy', dir),
  /** Dirs with the persisted forever flag (∞ badges on switcher rows / dock cards). */
  keepForeverDirs: (): Promise<string[]> => ipcRenderer.invoke('project:keepForeverDirs'),
  /** Background the ACTIVE project (dir resolved MAIN-side): park PTYs, freeze previews. */
  background: (): Promise<{ ok: boolean; terminals: number; previews: number }> =>
    ipcRenderer.invoke('project:background'),
  listBackground: (): Promise<BackgroundProjectInfo[]> =>
    ipcRenderer.invoke('project:listBackground'),
  /** Kill a BACKGROUNDED project's resources (registry-validated in MAIN). */
  closeBackground: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke('project:closeBackground', dir),
  /** Scoped close of the ACTIVE project's resources (never touches other residents). */
  closeActive: (): Promise<boolean> => ipcRenderer.invoke('project:closeActive'),
  /** Phase 4b: snapshot the ACTIVE project's canvas rect into the userData thumb cache
   *  (dir MAIN-resolved). False = capture failed — normal (the dock placeholders it). */
  captureThumb: (rect: { x: number; y: number; width: number; height: number }): Promise<boolean> =>
    ipcRenderer.invoke('project:captureThumb', rect),
  /** Phase 4b: cached thumbnails for the SESSION set (active + residents) as data URLs. */
  thumbs: (): Promise<Record<string, string>> => ipcRenderer.invoke('project:thumbs'),
  /** Single-dir thumb (the switch-transition snapshot) — cheaper than the whole map on the
   *  switch's animation-critical path. Null = no cached thumb / not a session dir. */
  thumb: (dir: string): Promise<string | null> => ipcRenderer.invoke('project:thumb', dir)
}

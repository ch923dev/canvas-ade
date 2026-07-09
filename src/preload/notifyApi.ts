import { ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The preload `notify` namespace (desktop-notifications) — MAIN → renderer pushes for agent
 * lifecycle. `onLifecycle` drives the in-app toast; `onFocusBoard` fires when the user clicks the
 * native OS notification (pan + select the board). Factored out of preload/index.ts like recapApi.
 */

/** Normalized agent-lifecycle event. MIRRORS src/main/agentLifecycle.ts (process boundary — no
 *  shared import; keep in lockstep, same as PtyState / RecapStatus). */
export type LifecycleEvent = 'done' | 'needs-input' | 'error'

export const notifyApi = {
  /** main → renderer: a board's agent fired a lifecycle event → show the in-app toast. */
  onLifecycle: (
    cb: (payload: { boardId: string; event: LifecycleEvent }) => void
  ): (() => void) => {
    const h = (_e: IpcRendererEvent, p: { boardId: string; event: LifecycleEvent }): void => cb(p)
    ipcRenderer.on('notify:lifecycle', h)
    return () => ipcRenderer.removeListener('notify:lifecycle', h)
  },
  /** main → renderer: the user clicked the OS notification → focus + pan to this board. */
  onFocusBoard: (cb: (payload: { boardId: string }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: { boardId: string }): void => cb(p)
    ipcRenderer.on('notify:focusBoard', h)
    return () => ipcRenderer.removeListener('notify:focusBoard', h)
  }
}

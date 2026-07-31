import { ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The preload `notify` namespace (desktop-notifications) — MAIN → renderer pushes for agent
 * lifecycle. `onLifecycle` drives the in-app toast; `onFocusBoard` fires when the user clicks the
 * native OS notification (pan + select the board). Factored out of preload/index.ts like recapApi.
 */

/** Normalized agent-lifecycle event. MIRRORS src/main/agentLifecycle.ts (process boundary — no
 *  shared import; keep in lockstep, same as PtyState / RecapStatus). */
export type LifecycleEvent = 'done' | 'needs-input' | 'error'

/**
 * Orchestration P4 — an OPTIONAL on-canvas attention override riding the same push.
 *
 * The gate (`gateNotification`) and the OS/toast layer keep speaking the three-member
 * `LifecycleEvent` vocabulary, so P4 adds NO notifications-config key, no settings row, and no
 * default to migrate: a blocked worker rides the existing `needs-input` event through the same
 * `onInput` switch. Only the RING is finer-grained — `attention:'blocked'` renders the steady warn
 * treatment instead of the pulsing one. Absent ⇒ the mark equals the event, exactly as before.
 */
export type LifecycleAttention = 'done' | 'needs-input' | 'blocked' | 'error'

/** The `notify:lifecycle` payload. MIRRORS src/main/lifecycleNotifications.ts. */
export interface LifecyclePayload {
  boardId: string
  event: LifecycleEvent
  attention?: LifecycleAttention
  /** P4 — the reason line the toast appends (`builder-1 is blocked — silent 11m`). Optional. */
  detail?: string
}

/** One backlog entry from `notify:drain`. MIRRORS src/main/notifyQueue.ts (process boundary). */
export type PendingNotify =
  | { t: 'lifecycle'; at: number; payload: LifecyclePayload }
  | { t: 'focus'; at: number; boardId: string }

export const notifyApi = {
  /** main → renderer: a board's agent fired a lifecycle event → show the in-app toast. */
  onLifecycle: (cb: (payload: LifecyclePayload) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: LifecyclePayload): void => cb(p)
    ipcRenderer.on('notify:lifecycle', h)
    return () => ipcRenderer.removeListener('notify:lifecycle', h)
  },
  /** main → renderer: the user clicked the OS notification → focus + pan to this board. */
  onFocusBoard: (cb: (payload: { boardId: string }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: { boardId: string }): void => cb(p)
    ipcRenderer.on('notify:focusBoard', h)
    return () => ipcRenderer.removeListener('notify:focusBoard', h)
  },
  /** Pull the events/focus intents that fired while no window existed (tray residency). MAIN
   *  clears the backlog on read — call once, in the same effect that installs the listeners. */
  drain: (): Promise<PendingNotify[]> => ipcRenderer.invoke('notify:drain')
}

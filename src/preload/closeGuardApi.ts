/**
 * Close-guard + PTY-host settings preload namespace (PR-2 background sessions; own file per
 * the mcpApi/recapApi max-lines precedent). `onCloseQuery` carries the close modal's round
 * trip: MAIN posts the session list + a per-request reply channel; the modal replies the
 * user's choice. Single-subscriber gate (the BUG-029 discipline): a second in-frame listener
 * could race the real modal to answer first — with `cancel` as MAIN's fail-safe floor the
 * worst forgery is a no-op, but the gate keeps the authority with the one real modal anyway.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CloseGuardAnswer, CloseGuardQuery, CloseSessionRow } from '../shared/closeGuardTypes'

export type { CloseGuardAnswer, CloseSessionRow }

/** Mirror of MAIN's PtyHostConfig (ptyHost/config.ts) — the Settings › Terminal rows. */
export interface PtyHostConfigView {
  surviveRestart: boolean
  onCloseWithSessions: 'ask' | 'keep' | 'stop'
  notifyBackgroundExit: boolean
}

export const closeGuardApi = {
  /** Subscribe the close modal. Returns an unsubscribe fn; at most ONE subscriber is wired. */
  onCloseQuery: (
    handler: (sessions: CloseSessionRow[], reply: (answer: CloseGuardAnswer) => void) => void
  ): (() => void) => {
    if (ipcRenderer.listenerCount('closeGuard:query') > 0) return () => {}
    const listener = (_e: IpcRendererEvent, msg: CloseGuardQuery): void => {
      handler(msg.sessions, (answer) => ipcRenderer.send(msg.replyChannel, answer))
    }
    ipcRenderer.on('closeGuard:query', listener)
    return () => ipcRenderer.removeListener('closeGuard:query', listener)
  },

  /** Settings › Terminal reads/writes (frame-guarded in MAIN; set merges onto current). */
  getConfig: (): Promise<PtyHostConfigView | null> => ipcRenderer.invoke('ptyhost:config:get'),
  setConfig: (patch: Partial<PtyHostConfigView>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ptyhost:config:set', patch)
}

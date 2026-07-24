/**
 * Swarm boards (orchestration S1) — the preload surface for the app-resident orchestrator
 * brain: one chat session per swarm board (multi-instance). Split out of index.ts for the
 * max-lines ratchet (the voice.ts precedent); index.ts mounts `swarmApi` under
 * `window.api.swarm`. Turn/run events are GLOBAL pushes carrying the runId (= the swarm
 * board id); the renderer's useSwarmEvents routes them into the per-board swarmStore.
 *
 * Payload shapes MIRROR src/main/swarmChatIpc.ts SwarmTurnEvent / SwarmRunEventPush
 * (process boundary → no shared import) — keep in lockstep.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export type SwarmTurnEventPayload =
  | { runId: string; id: number; kind: 'delta'; text: string }
  | { runId: string; id: number; kind: 'done'; text: string; cancelled: boolean }
  | { runId: string; id: number; kind: 'error'; reason: string }
  | {
      runId: string
      id: number
      kind: 'act'
      name: string
      summary: string
      phase: 'confirm' | 'running' | 'ok' | 'denied' | 'error'
    }

export interface SwarmRunEventPayload {
  runId: string
  ev:
    | { kind: 'workerSpawned'; workerId: string; role?: string; title: string }
    | { kind: 'planDrawn'; planBoardId: string }
    | { kind: 'activity'; workerId: string; text: string }
    | {
        kind: 'workerSettled'
        workerId: string
        provenance: 'claimed' | 'synthesized'
        status: string
      }
}

export const swarmApi = {
  startTurn: (
    runId: string,
    text: string
  ): Promise<{ ok: boolean; id?: number; reason?: string }> =>
    ipcRenderer.invoke('swarm:turn:start', { runId, text }),
  cancelTurn: (runId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('swarm:turn:cancel', { runId }),
  setPaused: (runId: string, paused: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('swarm:setPaused', { runId, paused }),
  onTurnEvent: (handler: (ev: SwarmTurnEventPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: SwarmTurnEventPayload): void => handler(ev)
    ipcRenderer.on('swarm:turn:event', listener)
    return () => ipcRenderer.removeListener('swarm:turn:event', listener)
  },
  onRunEvent: (handler: (ev: SwarmRunEventPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ev: SwarmRunEventPayload): void => handler(ev)
    ipcRenderer.on('swarm:runEvent', listener)
    return () => ipcRenderer.removeListener('swarm:runEvent', listener)
  }
}

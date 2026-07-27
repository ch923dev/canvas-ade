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
import type { SwarmLedgerSnapshot } from '../shared/swarmLedgerTypes'

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
    /**
     * S2: the durable run projection. Unlike the payload shapes above (hand-mirrored across the
     * process boundary), this one imports the SHARED declaration — `swarmLedgerTypes` is
     * dependency-free and type-only here, so MAIN, preload and the renderer cannot drift.
     */
    | { kind: 'ledger'; snapshot: SwarmLedgerSnapshot }
    /** S2: a between-turns run event narrated in the orchestrator's voice (worker died/stalled). */
    | { kind: 'narrate'; boardId?: string; status?: string; text: string }
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
  /** S2: ask MAIN to re-push this run's durable projection (the board calls it on mount). */
  restore: (runId: string): Promise<{ restored: boolean }> =>
    ipcRenderer.invoke('swarm:restore', { runId }),
  /** S2: stamp "seen up to now" so read results stop appearing as unreviewed triage rows. */
  markSeen: (runId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('swarm:markSeen', { runId }),
  /** S2: the swarm board was deleted — drop its durable run too. */
  destroyRun: (runId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('swarm:destroyRun', { runId }),
  /** S2: apply one triage-row action. A `reassign` returns the prompt to send as the next turn. */
  triageAction: (
    runId: string,
    taskId: string,
    action: string
  ): Promise<{ ok: boolean; prompt?: string }> =>
    ipcRenderer.invoke('swarm:triageAction', { runId, taskId, action }),
  /**
   * S3: dispose of a worker's dirty worktree (the `dirty_worktree` row's Resolve…). Separate from
   * `triageAction` because it needs async git and raises its own chooser + destructive second
   * confirm; MAIN re-derives the worktree from the ledger and never trusts anything but `taskId`.
   */
  worktreeDispose: (runId: string, taskId: string): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke('swarm:worktreeDispose', { runId, taskId }),
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

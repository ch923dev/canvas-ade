/**
 * Jarvis J3 — the preload surface for the brain session. Split out of index.ts for the
 * max-lines ratchet (voice.ts pattern); index.ts mounts `jarvisApi` under
 * `window.api.jarvis`. Control plane only — reply text streams back as `jarvis:turn:event`
 * pushes; audio rides the existing voice TTS surface.
 */
import { ipcRenderer } from 'electron'

/** Mirrors main jarvisConfig.ts (duplicated across the bundle boundary, like VoiceConfigView). */
export interface JarvisConfigView {
  enabled: boolean
  name: string
  tonePreset: 'butler' | 'mission-control' | 'pair-programmer' | 'custom'
  customToneText: string
  speakingRate: number
  verbosity: 'concise' | 'normal' | 'narrative'
  voiceSid?: number
  announcePolicy: 'all' | 'attention' | 'chips-only'
  model: string
  historyMode: 'session' | 'off'
}

export interface JarvisStatusView {
  hasKey: boolean
  encryptionAvailable: boolean
  mockEnabled: boolean
  config: JarvisConfigView
}

export type JarvisTurnEventView =
  | { id: number; kind: 'delta'; text: string }
  | { id: number; kind: 'done'; text: string; cancelled: boolean }
  | { id: number; kind: 'error'; reason: string }
  | {
      id: number
      kind: 'act'
      actId: number
      name: string
      summary: string
      phase: 'confirm' | 'running' | 'ok' | 'denied' | 'error'
      gated: boolean
    }

export interface JarvisTurnView {
  role: 'user' | 'assistant'
  text: string
}

export const jarvisApi = {
  status: (): Promise<JarvisStatusView> => ipcRenderer.invoke('jarvis:status'),
  /** Start one streaming turn; deltas/done/error arrive via onTurnEvent with the returned id. */
  startTurn: (text: string): Promise<{ ok: boolean; id?: number; reason?: string }> =>
    ipcRenderer.invoke('jarvis:turn:start', { text }),
  /** Barge-in: abort the in-flight turn's Claude stream (playback flush is the caller's job). */
  cancelTurn: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('jarvis:turn:cancel'),
  onTurnEvent: (cb: (ev: JarvisTurnEventView) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: JarvisTurnEventView): void => cb(ev)
    ipcRenderer.on('jarvis:turn:event', listener)
    return () => ipcRenderer.removeListener('jarvis:turn:event', listener)
  },
  history: {
    get: (): Promise<JarvisTurnView[]> => ipcRenderer.invoke('jarvis:history:get'),
    clear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('jarvis:history:clear')
  },
  config: {
    get: (): Promise<JarvisConfigView> => ipcRenderer.invoke('jarvis:config:get'),
    set: (patch: Partial<JarvisConfigView>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('jarvis:config:set', patch),
    onChanged: (cb: (cfg: JarvisConfigView) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, cfg: JarvisConfigView): void => cb(cfg)
      ipcRenderer.on('jarvis:config:changed', listener)
      return () => ipcRenderer.removeListener('jarvis:config:changed', listener)
    }
  }
}

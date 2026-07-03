/**
 * Voice V1/V2 — the preload surface for dictation (docs/research/2026-07-02-voice-to-text).
 * Split out of index.ts for the max-lines ratchet; index.ts mounts `voiceApi` under
 * `window.api.voice` and calls `forwardVoicePort()` once at load.
 */
import { ipcRenderer } from 'electron'

export interface VoiceModelListEntry {
  id: string
  label: string
  language: string
  license: string
  licenseNote?: string
  totalBytes: number
  isDefault: boolean
  status: 'ready' | 'absent'
}

export interface VoiceDownloadProgress {
  id: string
  receivedBytes: number
  totalBytes: number
  fileIndex: number
  fileCount: number
}

/** Mirrors main voiceConfig.ts (SPEC §5). autoSendOnFinal is typed literal-false —
 *  reserved, never honored in v1. */
export interface VoiceConfigView {
  engine: 'sherpa-onnx' | 'cloud'
  modelId: string
  language: string
  micDeviceId?: string
  hotkey?: string
  autoSendOnFinal: false
  cloudProvider?: string
  showPill: boolean
  pillPosition?: { x: number; y: number }
}

/** V5 engine-failure push (SPEC §3 `error` state). 'restarted' = MAIN transparently
 *  re-brokered the session after a crash (a fresh voice:port follows); 'error' = the
 *  restart budget is spent — stop capturing, keep the draft, offer Restart. */
export type VoiceEngineEvent = { kind: 'restarted' } | { kind: 'error'; reason?: string }

/**
 * Control plane (frames flow over a MessagePort, not IPC). start() makes MAIN broker a
 * session port — it arrives via forwardVoicePort below as `__voicePort`, and the port IS
 * the renderer's start signal. stop() makes the engine host post {t:'stop'} back over
 * the port (so the capture releases the mic) and returns the session's frame count.
 * models.* is the V2 catalog surface (download/delete/status; Settings UI lands in V4).
 */
export const voiceApi = {
  /** V5: false on win-arm64 (no sherpa prebuilt — approved gate). The pill renders
   *  nothing and Settings shows an "unavailable on this platform" row instead. */
  supported: !(process.platform === 'win32' && process.arch === 'arm64'),
  start: (): Promise<{ ok: boolean; micStatus: string; modelStatus: 'ready' | 'absent' }> =>
    ipcRenderer.invoke('voice:session:start'),
  stop: (): Promise<{ ok: boolean; frames: number }> => ipcRenderer.invoke('voice:session:stop'),
  onEngineEvent: (cb: (ev: VoiceEngineEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: VoiceEngineEvent): void => cb(ev)
    ipcRenderer.on('voice:engine:event', listener)
    return () => ipcRenderer.removeListener('voice:engine:event', listener)
  },
  models: {
    list: (): Promise<VoiceModelListEntry[]> => ipcRenderer.invoke('voice:models:list'),
    status: (id: string): Promise<'ready' | 'absent'> =>
      ipcRenderer.invoke('voice:models:status', id),
    download: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('voice:models:download', id),
    delete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('voice:models:delete', id),
    onDownloadProgress: (cb: (p: VoiceDownloadProgress) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: VoiceDownloadProgress): void => cb(p)
      ipcRenderer.on('voice:models:progress', listener)
      return () => ipcRenderer.removeListener('voice:models:progress', listener)
    }
  },
  // App-level voice config (userData/voice-config.json). set() is a merge-patch; MAIN
  // sanitizes through repairVoiceConfig and pushes the repaired result back on
  // voice:config:changed so consumers (pill visibility/hotkey) apply LIVE (V4).
  config: {
    get: (): Promise<VoiceConfigView> => ipcRenderer.invoke('voice:config:get'),
    set: (patch: Partial<VoiceConfigView>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('voice:config:set', patch),
    onChanged: (cb: (cfg: VoiceConfigView) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, cfg: VoiceConfigView): void => cb(cfg)
      ipcRenderer.on('voice:config:changed', listener)
      return () => ipcRenderer.removeListener('voice:config:changed', listener)
    }
  }
}

/**
 * The capture data-plane port: MessagePorts can't cross the contextBridge, so re-post
 * into the main world exactly like `pty:port` (same-origin pin, SEC-2). Single global
 * session — no id in the message.
 */
export function forwardVoicePort(): void {
  ipcRenderer.on('voice:port', (e) => {
    window.postMessage({ __voicePort: true }, window.location.origin, e.ports)
  })
}

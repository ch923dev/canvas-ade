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

/** V3 minimal config slice (mirrors main voiceConfig.ts; V4 adds the rest). */
export interface VoiceConfigView {
  showPill: boolean
  pillPosition?: { x: number; y: number }
}

/**
 * Control plane (frames flow over a MessagePort, not IPC). start() makes MAIN broker a
 * session port — it arrives via forwardVoicePort below as `__voicePort`, and the port IS
 * the renderer's start signal. stop() makes the engine host post {t:'stop'} back over
 * the port (so the capture releases the mic) and returns the session's frame count.
 * models.* is the V2 catalog surface (download/delete/status; Settings UI lands in V4).
 */
export const voiceApi = {
  start: (): Promise<{ ok: boolean; micStatus: string; modelStatus: 'ready' | 'absent' }> =>
    ipcRenderer.invoke('voice:session:start'),
  stop: (): Promise<{ ok: boolean; frames: number }> => ipcRenderer.invoke('voice:session:stop'),
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
  // V3: pill visibility + persisted drag position (userData/voice-config.json). set() is a
  // merge-patch; MAIN sanitizes through repairVoiceConfig.
  config: {
    get: (): Promise<VoiceConfigView> => ipcRenderer.invoke('voice:config:get'),
    set: (patch: Partial<VoiceConfigView>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('voice:config:set', patch)
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

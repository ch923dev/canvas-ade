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
  /** Sent voice prompts, newest first, capped (MAX_PROMPT_HISTORY in main). The flyout reads a
   *  Recent slice; Settings › Voice reads the whole list. A set() patch replaces it wholesale. */
  promptHistory: string[]
  /** J2: selected TTS model id (pinned catalog; unknown ids preserved, default at start). */
  ttsModelId: string
  /** J2 barge-in mode (D6): 'full' = transcription-gated interrupt; 'half' = mic
   *  suppressed while speaking, elevated-RMS burst interrupts (AEC-hostile machines). */
  ttsDuplex: 'full' | 'half'
}

/** J2: TTS-side failure push (worker/host death) — flush playback; the next speak
 *  lazily re-opens the session. */
export type VoiceTtsEvent = { kind: 'error'; reason?: string }

/** J5: wake-side failure push (KWS worker death) — the listener disarms; the next arm
 *  respawns the worker lazily. */
export type VoiceWakeEvent = { kind: 'error'; reason?: string }

/** V5 engine-failure push (SPEC §3 `error` state). 'restarted' = MAIN transparently
 *  re-brokered the session after a crash (a fresh voice:port follows); 'error' = the
 *  restart budget is spent — stop capturing, keep the draft, offer Restart. */
export type VoiceEngineEvent = { kind: 'restarted' } | { kind: 'error'; reason?: string }

/** The four catalog channels + progress push under one prefix — `voice:models` (STT)
 *  and `voice:tts:models` (J2) are the same surface over different catalogs. */
function modelCatalogApi(prefix: string): {
  list: () => Promise<VoiceModelListEntry[]>
  status: (id: string) => Promise<'ready' | 'absent'>
  download: (id: string) => Promise<{ ok: boolean; error?: string }>
  delete: (id: string) => Promise<{ ok: boolean; error?: string }>
  onDownloadProgress: (cb: (p: VoiceDownloadProgress) => void) => () => void
} {
  return {
    list: () => ipcRenderer.invoke(`${prefix}:list`),
    status: (id: string) => ipcRenderer.invoke(`${prefix}:status`, id),
    download: (id: string) => ipcRenderer.invoke(`${prefix}:download`, id),
    delete: (id: string) => ipcRenderer.invoke(`${prefix}:delete`, id),
    onDownloadProgress: (cb: (p: VoiceDownloadProgress) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: VoiceDownloadProgress): void => cb(p)
      ipcRenderer.on(`${prefix}:progress`, listener)
      return () => ipcRenderer.removeListener(`${prefix}:progress`, listener)
    }
  }
}

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
  models: modelCatalogApi('voice:models'),
  // ── J2 TTS: control plane (chunks flow over the voice:tts:port MessagePort). speak()
  // returns the utterance id chunk/done events carry; cancel() is the barge-in flush
  // (active synth stops at its next progress callback, the queue drains cancelled).
  tts: {
    start: (): Promise<{ ok: boolean; modelStatus: 'ready' | 'absent' }> =>
      ipcRenderer.invoke('voice:tts:start'),
    speak: (
      text: string,
      opts?: { sid?: number; speed?: number }
    ): Promise<{ ok: boolean; id?: number; error?: string }> =>
      ipcRenderer.invoke('voice:tts:speak', { text, ...opts }),
    cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('voice:tts:cancel'),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('voice:tts:stop'),
    status: (): Promise<{ modelId: string; modelStatus: 'ready' | 'absent'; active: boolean }> =>
      ipcRenderer.invoke('voice:tts:status'),
    onEvent: (cb: (ev: VoiceTtsEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: VoiceTtsEvent): void => cb(ev)
      ipcRenderer.on('voice:tts:event', listener)
      return () => ipcRenderer.removeListener('voice:tts:event', listener)
    },
    models: modelCatalogApi('voice:tts:models')
  },
  // ── J5 wake word (D3, opt-in): control plane for the closed-panel keyword listener.
  // Frames flow over the voice:wake:port MessagePort; a detection arrives on that port
  // as {t:'wake', keyword}. start() fails with modelStatus 'absent' until the KWS model
  // is downloaded (Settings › Persona row drives the CTA).
  wake: {
    start: (): Promise<{ ok: boolean; modelStatus: 'ready' | 'absent' }> =>
      ipcRenderer.invoke('voice:wake:start'),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('voice:wake:stop'),
    onEvent: (cb: (ev: VoiceWakeEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: VoiceWakeEvent): void => cb(ev)
      ipcRenderer.on('voice:wake:event', listener)
      return () => ipcRenderer.removeListener('voice:wake:event', listener)
    },
    models: modelCatalogApi('voice:kws:models')
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

/** J2: the TTS chunk-stream port, forwarded exactly like the capture port. */
export function forwardVoiceTtsPort(): void {
  ipcRenderer.on('voice:tts:port', (e) => {
    window.postMessage({ __voiceTtsPort: true }, window.location.origin, e.ports)
  })
}

/** J5: the wake-word capture/detection port, forwarded exactly like the capture port. */
export function forwardVoiceWakePort(): void {
  ipcRenderer.on('voice:wake:port', (e) => {
    window.postMessage({ __voiceWakePort: true }, window.location.origin, e.ports)
  })
}

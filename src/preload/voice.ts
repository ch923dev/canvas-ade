/**
 * Voice V1 — the preload surface for dictation (docs/research/2026-07-02-voice-to-text).
 * Split out of index.ts for the max-lines ratchet; index.ts mounts `voiceApi` under
 * `window.api.voice` and calls `forwardVoicePort()` once at load.
 */
import { ipcRenderer } from 'electron'

/**
 * Control plane (frames flow over a MessagePort, not IPC). start() makes MAIN broker a
 * session port — it arrives via forwardVoicePort below as `__voicePort`, and the port IS
 * the renderer's start signal. stop() makes MAIN's engine end post {t:'stop'} back over
 * the port (so the capture releases the mic) and returns the session's frame count.
 */
export const voiceApi = {
  start: (): Promise<{ ok: boolean; micStatus: string }> =>
    ipcRenderer.invoke('voice:session:start'),
  stop: (): Promise<{ ok: boolean; frames: number }> => ipcRenderer.invoke('voice:session:stop')
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

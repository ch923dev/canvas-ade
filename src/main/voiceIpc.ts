/**
 * Voice V1 — control plane + port broker (docs/research/2026-07-02-voice-to-text, SPEC §4).
 *
 * Control plane = IPC (`voice:session:start|stop`, frame-guarded); data plane = a
 * `MessageChannelMain` per session, cloned from the `pty:port` pattern: one end goes to
 * the renderer (`webContents.postMessage('voice:port', …)` → preload re-post as
 * `__voicePort`), the other end is the ENGINE seam. In V1 that seam is a logger stub
 * (counts frames; logs cadence under CANVAS_VOICE_DEBUG) — the V2 utilityProcess
 * sherpa-onnx host replaces `attachEngineStub` behind the same port shape. MAIN never
 * touches audio payload bytes (it reads byteLength only); one session at a time.
 *
 * The fake-media switches (Playwright e2e — env-gated in MAIN, NOT launch args:
 * playwright#16621) also live here; index.ts applies them at module scope because
 * `app.commandLine.appendSwitch` must run before app.ready.
 */
import { MessageChannelMain, systemPreferences } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import { isForeignSender } from './ipcGuard'

export interface VoiceStartResult {
  ok: boolean
  /** OS-level mic grant (`systemPreferences.getMediaAccessStatus`) — 'granted' | 'denied' |
   *  'not-determined' | 'restricted', or 'unknown' where the API is absent (Linux). The
   *  silent-zeros watchdog's companion signal (electron#42714): a denied OS grant streams
   *  live zeros with no error, so the renderer can't detect it alone. */
  micStatus: string
}

export interface VoiceStopResult {
  ok: boolean
  /** Frames the engine end received this session — proves renderer → MAIN flow. */
  frames: number
}

/** Structural view of MessagePortMain so the stub is unit-testable without electron. */
export interface EnginePortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  start(): void
  postMessage(msg: unknown): void
  close(): void
}

export interface EngineStub {
  frames(): number
  /** Tell the renderer to release the mic ({t:'stop'}), then close this end. */
  dispose(): void
}

/**
 * V1 engine seam: count incoming frames; under `debug`, log cadence once a second-ish
 * (every 8th frame) so the dev check can watch ~8 frames/s without an IPC-storm of lines.
 * `now` is injectable for deterministic cadence math in tests.
 */
export function attachEngineStub(
  port: EnginePortLike,
  opts: { debug?: boolean; log?: (line: string) => void; now?: () => number } = {}
): EngineStub {
  const log = opts.log ?? console.log
  const now = opts.now ?? Date.now
  let frames = 0
  let firstAt = 0
  port.on('message', (e) => {
    const m = e.data as { t?: string; d?: unknown } | null
    if (!m || m.t !== 'frame' || !(m.d instanceof ArrayBuffer)) return
    frames++
    if (frames === 1) firstAt = now()
    if (opts.debug && frames % 8 === 0) {
      const elapsedS = (now() - firstAt) / 1000
      const rate = elapsedS > 0 ? (frames - 1) / elapsedS : 0
      log(`[voice] stub: ${frames} frames, ${rate.toFixed(1)}/s, ${m.d.byteLength} B each`)
    }
  })
  port.start()
  return {
    frames: () => frames,
    dispose() {
      try {
        port.postMessage({ t: 'stop' })
      } catch {
        /* port already closed (renderer gone) */
      }
      port.close()
    }
  }
}

/** Structural view of `app.commandLine` (unit-testable switch mapping). */
export interface CommandLineLike {
  appendSwitch(key: string, value?: string): void
}

/**
 * CANVAS_FAKE_MEDIA=1 → Chromium's fake capture device (a generated tone — deterministic,
 * no OS mic/permission dialogs); CANVAS_FAKE_MEDIA_WAV=<path> additionally plays a 16-bit
 * PCM WAV as the mic signal (append `%noloop` to the path to play once). Returns whether
 * anything was applied. MUST run before app.ready.
 */
export function applyFakeMediaSwitches(
  env: Record<string, string | undefined>,
  cmd: CommandLineLike
): boolean {
  if (!env.CANVAS_FAKE_MEDIA) return false
  cmd.appendSwitch('use-fake-device-for-media-stream')
  if (env.CANVAS_FAKE_MEDIA_WAV) {
    cmd.appendSwitch('use-file-for-fake-audio-capture', env.CANVAS_FAKE_MEDIA_WAV)
  }
  return true
}

/** OS mic grant, or 'unknown' where the API is absent/throws (Linux). */
function micAccessStatus(): string {
  try {
    return systemPreferences.getMediaAccessStatus('microphone')
  } catch {
    return 'unknown'
  }
}

// The single live session's MAIN-side end. V1 is one global session (no per-board id —
// dictation targets a board at INJECTION time in V3, not at capture time).
let active: EngineStub | null = null

function disposeActive(): void {
  active?.dispose()
  active = null
}

export function registerVoiceHandlers(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  ipcMain.handle('voice:session:start', (e): VoiceStartResult => {
    if (isForeignSender(e, getWin)) return { ok: false, micStatus: 'unknown' }
    const win = getWin()
    if (!win) return { ok: false, micStatus: 'unknown' }
    disposeActive() // restart-idempotent: a second start replaces the live session
    const { port1, port2 } = new MessageChannelMain()
    active = attachEngineStub(port1, { debug: !!process.env.CANVAS_VOICE_DEBUG })
    win.webContents.postMessage('voice:port', {}, [port2])
    return { ok: true, micStatus: micAccessStatus() }
  })

  ipcMain.handle('voice:session:stop', (e): VoiceStopResult => {
    if (isForeignSender(e, getWin)) return { ok: false, frames: 0 }
    const frames = active?.frames() ?? 0
    disposeActive()
    return { ok: true, frames }
  })
}

/** Tear down the live session (window close / app quit paths; safe when none). */
export function disposeVoiceSession(): void {
  disposeActive()
}

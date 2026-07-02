/**
 * Voice V2 — control plane + port broker (docs/research/2026-07-02-voice-to-text, SPEC §4).
 *
 * Control plane = IPC (`voice:session:*`, `voice:models:*`, frame-guarded); data plane = a
 * `MessageChannelMain` per session, cloned from the `pty:port` pattern: one end goes to
 * the renderer (`webContents.postMessage('voice:port', …)` → preload re-post as
 * `__voicePort`), the other end is transferred into the sherpa-onnx **utilityProcess
 * engine host** (voiceEngine.ts / voiceEngineHost.ts — replaced the V1 logger stub behind
 * the same port shape). MAIN never touches audio payload bytes; one session at a time.
 *
 * The fake-media switches (Playwright e2e — env-gated in MAIN, NOT launch args:
 * playwright#16621) also live here; index.ts applies them at module scope because
 * `app.commandLine.appendSwitch` must run before app.ready.
 */
import { app, MessageChannelMain, systemPreferences } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import { isForeignSender } from './ipcGuard'
import { createVoiceEngine, type VoiceEngineHandle } from './voiceEngine'
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODEL_CATALOG,
  deleteModel,
  downloadModel,
  modelPaths,
  modelStatus,
  sweepStaging,
  type DownloadProgress,
  type VoiceModelStatus
} from './voiceModels'

export interface VoiceStartResult {
  ok: boolean
  /** OS-level mic grant (`systemPreferences.getMediaAccessStatus`) — 'granted' | 'denied' |
   *  'not-determined' | 'restricted', or 'unknown' where the API is absent (Linux). The
   *  silent-zeros watchdog's companion signal (electron#42714): a denied OS grant streams
   *  live zeros with no error, so the renderer can't detect it alone. */
  micStatus: string
  /** Default model's install state — 'absent' drives the flyout's model-missing CTA (V3);
   *  capture still runs (the host counts frames, no recognizer). */
  modelStatus: VoiceModelStatus
}

export interface VoiceStopResult {
  ok: boolean
  /** Frames the engine host received this session — proves renderer → host flow. */
  frames: number
}

export interface VoiceModelListEntry {
  id: string
  label: string
  language: string
  license: string
  licenseNote?: string
  totalBytes: number
  isDefault: boolean
  status: VoiceModelStatus
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

/** Injectable seams so the handlers unit-test without electron / the network. */
export interface VoiceIpcDeps {
  engine?: VoiceEngineHandle
  getUserData?: () => string
  modelOps?: {
    status: typeof modelStatus
    paths: typeof modelPaths
    download: typeof downloadModel
    remove: typeof deleteModel
    sweep: typeof sweepStaging
  }
}

// The single live engine handle. V1's per-session stub became a persistent host process
// (its recognizer cache makes mic re-toggles cheap); sessions inside it replace each other.
let engineSingleton: VoiceEngineHandle | null = null

function defaultEngine(): VoiceEngineHandle {
  if (!engineSingleton) engineSingleton = createVoiceEngine()
  return engineSingleton
}

export function registerVoiceHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: VoiceIpcDeps = {}
): void {
  const getUserData = deps.getUserData ?? ((): string => app.getPath('userData'))
  const ops = deps.modelOps ?? {
    status: modelStatus,
    paths: modelPaths,
    download: downloadModel,
    remove: deleteModel,
    sweep: sweepStaging
  }
  const engine = (): VoiceEngineHandle => deps.engine ?? defaultEngine()

  // Crash-mid-download leftovers (fire-and-forget; the dir may not exist yet).
  void ops.sweep(getUserData()).catch(() => {})

  ipcMain.handle('voice:session:start', async (e): Promise<VoiceStartResult> => {
    if (isForeignSender(e, getWin)) {
      return { ok: false, micStatus: 'unknown', modelStatus: 'absent' }
    }
    const win = getWin()
    if (!win) return { ok: false, micStatus: 'unknown', modelStatus: 'absent' }
    const userData = getUserData()
    // V4 makes the model user-selectable via voiceConfig; V2 pins the default.
    const status = await ops.status(userData, DEFAULT_VOICE_MODEL_ID)
    const paths = status === 'ready' ? ops.paths(userData, DEFAULT_VOICE_MODEL_ID) : null
    const { port1, port2 } = new MessageChannelMain()
    // Restart-idempotent: the host replaces any live session (the old renderer port gets
    // {t:'stop'}, so a stale capture releases the mic).
    engine().startSession(port1, paths)
    win.webContents.postMessage('voice:port', {}, [port2])
    return { ok: true, micStatus: micAccessStatus(), modelStatus: status }
  })

  ipcMain.handle('voice:session:stop', async (e): Promise<VoiceStopResult> => {
    if (isForeignSender(e, getWin)) return { ok: false, frames: 0 }
    const { frames } = await engine().stopSession()
    return { ok: true, frames }
  })

  ipcMain.handle('voice:models:list', async (e): Promise<VoiceModelListEntry[]> => {
    if (isForeignSender(e, getWin)) return []
    const userData = getUserData()
    return Promise.all(
      VOICE_MODEL_CATALOG.map(async (m) => ({
        id: m.id,
        label: m.label,
        language: m.language,
        license: m.license,
        licenseNote: m.licenseNote,
        totalBytes: m.totalBytes,
        isDefault: m.id === DEFAULT_VOICE_MODEL_ID,
        status: await ops.status(userData, m.id)
      }))
    )
  })

  ipcMain.handle('voice:models:status', async (e, id: unknown): Promise<VoiceModelStatus> => {
    if (isForeignSender(e, getWin) || typeof id !== 'string') return 'absent'
    return ops.status(getUserData(), id)
  })

  // One download at a time (the manifest files stream sequentially anyway); progress is
  // throttled to ~every 512 KB so a 70 MB model doesn't emit a thousand IPC events.
  const downloading = new Set<string>()
  ipcMain.handle(
    'voice:models:download',
    async (e, id: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (isForeignSender(e, getWin) || typeof id !== 'string') return { ok: false }
      if (downloading.size > 0) return { ok: false, error: 'download already in progress' }
      downloading.add(id)
      let lastSent = 0
      const onProgress = (p: DownloadProgress): void => {
        if (p.receivedBytes - lastSent < 512 * 1024 && p.receivedBytes !== p.totalBytes) return
        lastSent = p.receivedBytes
        getWin()?.webContents.send('voice:models:progress', p)
      }
      try {
        await ops.download(getUserData(), id, { onProgress })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        downloading.delete(id)
      }
    }
  )

  ipcMain.handle(
    'voice:models:delete',
    async (e, id: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (isForeignSender(e, getWin) || typeof id !== 'string') return { ok: false }
      if (downloading.has(id)) return { ok: false, error: 'download in progress' }
      try {
        await ops.remove(getUserData(), id)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

/** Tear down the engine host + any live session (window close / app quit; safe when none). */
export function disposeVoiceSession(): void {
  engineSingleton?.dispose()
  engineSingleton = null
}

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
import { currentVoiceStubEngine } from './voiceEngineStub'
import {
  readVoiceConfig,
  repairVoiceConfig,
  writeVoiceConfig,
  type VoiceConfig
} from './voiceConfig'
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODEL_CATALOG,
  deleteModel,
  downloadModel,
  modelPaths,
  modelStatus,
  sweepStaging,
  type DownloadProgress,
  type VoiceModelPaths,
  type VoiceModelStatus
} from './voiceModels'
import {
  DEFAULT_TTS_MODEL_ID,
  TTS_MODEL_CATALOG,
  deleteTtsModel,
  downloadTtsModel,
  getTtsModelSpec,
  ttsModelPaths,
  ttsModelStatus,
  type TtsModelStatus
} from './voiceTtsModels'

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
  /** J2: TTS catalog ops (status/paths/download/delete), injectable like modelOps. */
  ttsModelOps?: {
    status: typeof ttsModelStatus
    paths: typeof ttsModelPaths
    download: typeof downloadTtsModel
    remove: typeof deleteTtsModel
  }
}

/** J2: `voice:tts:start` result — a session only brokers when the model is installed. */
export interface VoiceTtsStartResult {
  ok: boolean
  modelStatus: TtsModelStatus
}

/** J2: renderer push for TTS-side failures (worker death / host death — the playback
 *  queue flushes and the next speak lazily re-opens the session). */
export type VoiceTtsEvent = { kind: 'error'; reason?: string }

// The single live engine handle. V1's per-session stub became a persistent host process
// (its recognizer cache makes mic re-toggles cheap); sessions inside it replace each other.
let engineSingleton: VoiceEngineHandle | null = null

function defaultEngine(): VoiceEngineHandle {
  if (!engineSingleton) engineSingleton = createVoiceEngine()
  return engineSingleton
}

/** V5: sherpa-onnx ships no win-arm64 prebuilt — the feature is gated OFF there
 *  (approved decision; the preload mirrors this so the pill/Settings never render). */
export function isVoicePlatformSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return !(platform === 'win32' && arch === 'arm64')
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
  const ttsOps = deps.ttsModelOps ?? {
    status: ttsModelStatus,
    paths: ttsModelPaths,
    download: downloadTtsModel,
    remove: deleteTtsModel
  }
  // Resolution order: explicit test injection → the e2e runtime stub (dormant null in
  // every normal run — only settable through e2eMain's gated registry) → the real host.
  const engine = (): VoiceEngineHandle => deps.engine ?? currentVoiceStubEngine() ?? defaultEngine()

  // Crash-mid-download leftovers (fire-and-forget; the dir may not exist yet).
  void ops.sweep(getUserData()).catch(() => {})

  // ── V5 crash policy (SPEC §3 `error` state): while a session is live, an engine
  // failure (host exit / decoder death) re-brokers the session ONCE transparently —
  // the fresh voice:port replaces the renderer capture in place. A second failure in
  // the same user-started session pushes `voice:engine:event {kind:'error'}`; the
  // renderer stops its capture, keeps the draft, and offers Restart.
  let liveModel: VoiceModelPaths | null = null
  let liveActive = false
  let restartedOnce = false
  // J2 TTS session state. `hostFailureAlsoFails` lets the TTS block below observe a
  // WHOLE-host failure (which kills any TTS session too) without reordering this file —
  // it is assigned once the TTS handlers are registered.
  let ttsActive = false
  let hostFailureAlsoFails: ((reason: string) => void) | null = null

  const brokerSession = (paths: VoiceModelPaths | null): boolean => {
    const win = getWin()
    if (!win) return false
    const { port1, port2 } = new MessageChannelMain()
    // Restart-idempotent: the host replaces any live session (the old renderer port gets
    // {t:'stop'}, so a stale capture releases the mic).
    engine().startSession(port1, paths)
    win.webContents.postMessage('voice:port', {}, [port2])
    return true
  }

  const onEngineFailure = (reason: string): void => {
    hostFailureAlsoFails?.(reason) // a dead host takes any live TTS session with it
    if (!liveActive) return // idle host death — the next start respawns anyway
    if (!restartedOnce) {
      restartedOnce = true
      if (brokerSession(liveModel)) {
        getWin()?.webContents.send('voice:engine:event', { kind: 'restarted' })
        return
      }
    }
    liveActive = false
    getWin()?.webContents.send('voice:engine:event', { kind: 'error', reason })
  }

  ipcMain.handle('voice:session:start', async (e): Promise<VoiceStartResult> => {
    if (isForeignSender(e, getWin)) {
      return { ok: false, micStatus: 'unknown', modelStatus: 'absent' }
    }
    // Defense-in-depth: the preload `supported` flag already hides every entry point.
    if (!isVoicePlatformSupported()) {
      return { ok: false, micStatus: 'unknown', modelStatus: 'absent' }
    }
    const win = getWin()
    if (!win) return { ok: false, micStatus: 'unknown', modelStatus: 'absent' }
    const userData = getUserData()
    // With the e2e stub engine active the session is model-live BY DESIGN (canned
    // partials/finals, no files) — report 'ready' so the flyout renders the composer,
    // not the Download CTA. The Linux Docker leg has no model on disk, and 'absent'
    // there swapped the flyout body for the model-missing row and failed the composer
    // specs Linux-only. deps.engine (unit-test injection) keeps the real disk check.
    const stubActive = !deps.engine && currentVoiceStubEngine() !== null
    // V4: the configured model drives the session. An id missing from the catalog is
    // preserved on disk but falls back to the default here (scene-id discipline).
    const cfgModel = readVoiceConfig(userData).modelId
    const modelId = VOICE_MODEL_CATALOG.some((m) => m.id === cfgModel)
      ? cfgModel
      : DEFAULT_VOICE_MODEL_ID
    const status = stubActive ? 'ready' : await ops.status(userData, modelId)
    const paths = !stubActive && status === 'ready' ? ops.paths(userData, modelId) : null
    liveModel = paths
    liveActive = true
    restartedOnce = false // a user-started session gets a fresh restart budget
    engine().onEngineFailure(onEngineFailure)
    if (!brokerSession(paths)) {
      liveActive = false
      return { ok: false, micStatus: 'unknown', modelStatus: 'absent' }
    }
    return { ok: true, micStatus: micAccessStatus(), modelStatus: status }
  })

  ipcMain.handle('voice:session:stop', async (e): Promise<VoiceStopResult> => {
    if (isForeignSender(e, getWin)) return { ok: false, frames: 0 }
    liveActive = false // a stop is user intent — a crash after it needs no restart
    const { frames } = await engine().stopSession()
    return { ok: true, frames }
  })

  // Model catalog channels — one registration per catalog: `voice:models:*` (STT) and
  // `voice:tts:models:*` (J2 TTS), byte-identical semantics (list/status/download/delete,
  // throttled progress push, per-catalog single-flight).
  registerModelCatalogIpc(ipcMain, getWin, getUserData, {
    prefix: 'voice:models',
    catalog: VOICE_MODEL_CATALOG,
    defaultId: DEFAULT_VOICE_MODEL_ID,
    status: ops.status,
    download: ops.download,
    remove: ops.remove
  })
  registerModelCatalogIpc(ipcMain, getWin, getUserData, {
    prefix: 'voice:tts:models',
    catalog: TTS_MODEL_CATALOG,
    defaultId: DEFAULT_TTS_MODEL_ID,
    status: ttsOps.status,
    download: ttsOps.download,
    remove: ttsOps.remove
  })

  // App voice config (SPEC §5). set() is a merge-patch funneled through repairVoiceConfig
  // so a malformed renderer payload can never write junk to disk; the repaired result is
  // pushed back on voice:config:changed so consumers apply LIVE (V4 — the Settings
  // showPill/hotkey toggles take effect without a pill remount).
  ipcMain.handle('voice:config:get', async (e): Promise<VoiceConfig> => {
    if (isForeignSender(e, getWin)) return repairVoiceConfig(null)
    return readVoiceConfig(getUserData())
  })

  ipcMain.handle('voice:config:set', async (e, patch: unknown): Promise<{ ok: boolean }> => {
    if (isForeignSender(e, getWin) || typeof patch !== 'object' || patch === null) {
      return { ok: false }
    }
    const userData = getUserData()
    const next = repairVoiceConfig({ ...readVoiceConfig(userData), ...patch })
    writeVoiceConfig(userData, next)
    getWin()?.webContents.send('voice:config:changed', next)
    return { ok: true }
  })

  // ── J2 TTS session + speak control (data plane = the voice:tts:port chunk stream) ──
  let ttsSpeakId = 0

  const configuredTtsModelId = (): string => {
    const cfg = readVoiceConfig(getUserData()).ttsModelId
    return TTS_MODEL_CATALOG.some((m) => m.id === cfg) ? cfg : DEFAULT_TTS_MODEL_ID
  }

  const onTtsFailure = (reason: string): void => {
    if (!ttsActive) return
    ttsActive = false
    getWin()?.webContents.send('voice:tts:event', {
      kind: 'error',
      reason
    } satisfies VoiceTtsEvent)
  }
  // The whole host dying takes any TTS session with it. The STT side restarts itself
  // (restart-once above); TTS stays lazy — the renderer flushes on the event and the
  // next speak re-opens a session against the fresh host.
  hostFailureAlsoFails = onTtsFailure

  ipcMain.handle('voice:tts:start', async (e): Promise<VoiceTtsStartResult> => {
    if (isForeignSender(e, getWin) || !isVoicePlatformSupported()) {
      return { ok: false, modelStatus: 'absent' }
    }
    const win = getWin()
    if (!win) return { ok: false, modelStatus: 'absent' }
    const userData = getUserData()
    const modelId = configuredTtsModelId()
    const status = await ttsOps.status(userData, modelId)
    const paths = status === 'ready' ? ttsOps.paths(userData, modelId) : null
    // No count-only degraded mode here (unlike STT): a TTS session without a model has
    // nothing to stream — fail fast and let Settings drive the download CTA.
    if (!paths) return { ok: false, modelStatus: status }
    engine().onTtsFailure(onTtsFailure)
    // A TTS-only user still needs host-death observation (STT may never have started —
    // without this the exit escalation would have no listener to reach onTtsFailure).
    engine().onEngineFailure(onEngineFailure)
    const { port1, port2 } = new MessageChannelMain()
    engine().startTtsSession(port1, paths)
    win.webContents.postMessage('voice:tts:port', {}, [port2])
    ttsActive = true
    return { ok: true, modelStatus: status }
  })

  ipcMain.handle(
    'voice:tts:speak',
    async (e, payload: unknown): Promise<{ ok: boolean; id?: number; error?: string }> => {
      if (isForeignSender(e, getWin)) return { ok: false }
      if (!ttsActive) return { ok: false, error: 'no tts session' }
      const p = payload as { text?: unknown; sid?: unknown; speed?: unknown } | null
      const text = typeof p?.text === 'string' ? p.text.trim() : ''
      if (!text || text.length > 2000) return { ok: false, error: 'invalid text' }
      const spec = getTtsModelSpec(configuredTtsModelId())
      const sid =
        typeof p?.sid === 'number' && Number.isInteger(p.sid) && p.sid >= 0
          ? p.sid
          : (spec?.defaultSid ?? 0)
      const speed =
        typeof p?.speed === 'number' && Number.isFinite(p.speed)
          ? Math.min(2, Math.max(0.5, p.speed))
          : 1.0
      const id = ++ttsSpeakId
      engine().ttsSpeak({ id, text, sid, speed })
      return { ok: true, id }
    }
  )

  ipcMain.handle('voice:tts:cancel', async (e): Promise<{ ok: boolean }> => {
    if (isForeignSender(e, getWin)) return { ok: false }
    engine().ttsCancel()
    return { ok: true }
  })

  ipcMain.handle('voice:tts:stop', async (e): Promise<{ ok: boolean }> => {
    if (isForeignSender(e, getWin)) return { ok: false }
    ttsActive = false
    engine().stopTtsSession()
    return { ok: true }
  })

  ipcMain.handle(
    'voice:tts:status',
    async (e): Promise<{ modelId: string; modelStatus: TtsModelStatus; active: boolean }> => {
      if (isForeignSender(e, getWin)) return { modelId: '', modelStatus: 'absent', active: false }
      const modelId = configuredTtsModelId()
      return {
        modelId,
        modelStatus: await ttsOps.status(getUserData(), modelId),
        active: ttsActive
      }
    }
  )
}

/** Everything the shared catalog registration needs from a model spec (STT and TTS
 *  catalog entries both satisfy it structurally). */
interface CatalogEntryMeta {
  id: string
  label: string
  language: string
  license: string
  licenseNote?: string
  totalBytes: number
}

/**
 * Register the four catalog channels under `<prefix>:list|status|download|delete` plus
 * the `<prefix>:progress` push. One download at a time per catalog (the manifest files
 * stream sequentially anyway); progress is throttled to ~every 512 KB so a large model
 * doesn't emit a thousand IPC events.
 */
function registerModelCatalogIpc(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  getUserData: () => string,
  cfg: {
    prefix: string
    catalog: CatalogEntryMeta[]
    defaultId: string
    status: (userData: string, id: string) => Promise<VoiceModelStatus>
    download: (
      userData: string,
      id: string,
      deps: { onProgress?: (p: DownloadProgress) => void }
    ) => Promise<void>
    remove: (userData: string, id: string) => Promise<void>
  }
): void {
  ipcMain.handle(`${cfg.prefix}:list`, async (e): Promise<VoiceModelListEntry[]> => {
    if (isForeignSender(e, getWin)) return []
    const userData = getUserData()
    return Promise.all(
      cfg.catalog.map(async (m) => ({
        id: m.id,
        label: m.label,
        language: m.language,
        license: m.license,
        licenseNote: m.licenseNote,
        totalBytes: m.totalBytes,
        isDefault: m.id === cfg.defaultId,
        status: await cfg.status(userData, m.id)
      }))
    )
  })

  ipcMain.handle(`${cfg.prefix}:status`, async (e, id: unknown): Promise<VoiceModelStatus> => {
    if (isForeignSender(e, getWin) || typeof id !== 'string') return 'absent'
    return cfg.status(getUserData(), id)
  })

  const downloading = new Set<string>()
  ipcMain.handle(
    `${cfg.prefix}:download`,
    async (e, id: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (isForeignSender(e, getWin) || typeof id !== 'string') return { ok: false }
      if (downloading.size > 0) return { ok: false, error: 'download already in progress' }
      downloading.add(id)
      let lastSent = 0
      const onProgress = (p: DownloadProgress): void => {
        if (p.receivedBytes - lastSent < 512 * 1024 && p.receivedBytes !== p.totalBytes) return
        lastSent = p.receivedBytes
        getWin()?.webContents.send(`${cfg.prefix}:progress`, p)
      }
      try {
        await cfg.download(getUserData(), id, { onProgress })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        downloading.delete(id)
      }
    }
  )

  ipcMain.handle(
    `${cfg.prefix}:delete`,
    async (e, id: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (isForeignSender(e, getWin) || typeof id !== 'string') return { ok: false }
      if (downloading.has(id)) return { ok: false, error: 'download in progress' }
      try {
        await cfg.remove(getUserData(), id)
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

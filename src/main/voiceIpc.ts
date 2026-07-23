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
import { createCloudSttEngine, type CloudSttEvent } from './cloudSttEngine'
import { createCloudTtsEngine } from './cloudTtsEngine'
import { createOpenAiTranscribe, type TranscribeFetch } from './openaiTranscribe'
import { createOpenAiSpeak, type SpeakFetch } from './openaiSpeak'
import { createSymbolProvider, type SymbolProvider } from './voiceSymbols'
import { keyForProvider } from './llmService'
import { createKeyStore, type Encryptor, type KeyStore } from './llmKeyStore'
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
import {
  DEFAULT_KWS_MODEL_ID,
  KWS_MODEL_CATALOG,
  deleteKwsModel,
  downloadKwsModel,
  kwsModelPaths,
  kwsModelStatus,
  type KwsModelStatus
} from './voiceKwsModels'

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
  // ── Phase 2 cloud STT (all optional; the real wiring injects the safeStorage encryptor +
  //    getCurrentDir, unit tests inject keyStore/symbols/transcribeFetch directly) ──
  /** safeStorage encryptor → the OpenAI key store (MAIN-side only, mirrors jarvisIpc). */
  encryptor?: Encryptor
  /** Direct key-store injection (unit tests); else built from `encryptor` + userData. */
  keyStore?: Pick<KeyStore, 'hasKey' | 'getKey'>
  /** The open project dir, for the file-tree symbol provider (index.ts: getCurrentDir). */
  getProjectDir?: () => string | null
  /** Direct symbol-provider injection (unit tests); else built from `getProjectDir`. */
  symbols?: SymbolProvider
  /** Injectable transcription transport (unit/e2e); default = global fetch (undici). */
  transcribeFetch?: TranscribeFetch
  /** Override the OpenAI base URL (e2e fake vendor); default reads CANVAS_VOICE_OPENAI_BASE. */
  transcribeBaseUrl?: () => string
  /** Phase 3: injectable speech transport (unit/e2e); default = global fetch (undici). */
  speakFetch?: SpeakFetch
  /** Phase 3: override the OpenAI speech base URL (e2e fake vendor); default = CANVAS_VOICE_OPENAI_BASE. */
  speakBaseUrl?: () => string
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
  /** J5: wake-word catalog ops, injectable like the others. */
  kwsModelOps?: {
    status: typeof kwsModelStatus
    paths: typeof kwsModelPaths
    download: typeof downloadKwsModel
    remove: typeof deleteKwsModel
  }
}

/** J5: `voice:wake:start` result — a session only brokers when the model is installed
 *  (or the e2e stub is live). */
export interface VoiceWakeStartResult {
  ok: boolean
  modelStatus: KwsModelStatus
}

/** J5: renderer push for wake-side failures (worker death — the listener disarms; the
 *  next arm respawns the worker lazily). */
export type VoiceWakeEvent = { kind: 'error'; reason?: string }

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
  const kwsOps = deps.kwsModelOps ?? {
    status: kwsModelStatus,
    paths: kwsModelPaths,
    download: downloadKwsModel,
    remove: deleteKwsModel
  }
  // ── Phase 2 cloud STT selection (decision #4: composite in-main, key never leaves MAIN) ──
  // The key store is built here from the injected safeStorage encryptor (jarvisIpc pattern); a
  // dev OPENAI_API_KEY env var is the store-less fallback (keyForProvider). Presence only ever
  // reaches the renderer via the shared llm:hasKey channel.
  const keyStore: Pick<KeyStore, 'hasKey' | 'getKey'> | undefined =
    deps.keyStore ?? (deps.encryptor ? createKeyStore(getUserData(), deps.encryptor) : undefined)
  const hasOpenAiKey = (): boolean => keyForProvider('openai', process.env, keyStore) !== undefined
  // File-tree symbol provider (decision #1): top-30 bias + full formatRestore dict, cached +
  // self-refreshing on project switch. Eager first build for the project open at boot.
  const symbols: SymbolProvider =
    deps.symbols ??
    createSymbolProvider({ getProjectDir: deps.getProjectDir ?? ((): null => null) })
  symbols.refresh()
  // Deliver a cloud batch result/status to the renderer OUT-OF-BAND — useVoiceCapture closes its
  // session port right after {t:'eos'}, so the ~0.8 s-later final can't ride the port back.
  const emitTranscript = (ev: CloudSttEvent): void => {
    getWin()?.webContents.send('voice:transcript', ev)
  }
  const transcribe = createOpenAiTranscribe({
    getKey: () => keyForProvider('openai', process.env, keyStore), // MAIN-side only, never returned out
    getModel: () => readVoiceConfig(getUserData()).sttModel,
    getBaseUrl:
      deps.transcribeBaseUrl ?? ((): string => process.env.CANVAS_VOICE_OPENAI_BASE || ''),
    fetch: deps.transcribeFetch
  })
  // Phase 3: the cloud TTS speak seam. Shares the openai key + the base-URL override with STT; the
  // key is read MAIN-side inside the getKey closure and never returned out.
  const speak = createOpenAiSpeak({
    getKey: () => keyForProvider('openai', process.env, keyStore), // MAIN-side only, never returned out
    getModel: () => readVoiceConfig(getUserData()).ttsCloudModel,
    getVoice: () => readVoiceConfig(getUserData()).ttsVoice,
    getBaseUrl: deps.speakBaseUrl ?? ((): string => process.env.CANVAS_VOICE_OPENAI_BASE || ''),
    fetch: deps.speakFetch
  })
  /** Cloud STT / cloud TTS are each on only when configured AND a key is present; else that layer
   *  falls back to local (the renderer surfaces the "set OpenAI key" note via config + llm:hasKey). */
  const useCloud = (): boolean =>
    readVoiceConfig(getUserData()).engine === 'cloud' && hasOpenAiKey()
  const useCloudTts = (): boolean =>
    readVoiceConfig(getUserData()).ttsEngine === 'cloud' && hasOpenAiKey()

  // The STT and TTS cloud tiers are INDEPENDENT (design decision #1: cloud STT + local TTS, or the
  // reverse, must be mixable). Each is a STABLE per-domain singleton over the persistent local host,
  // built once and NEVER rebuilt — so a config toggle can't discard live session state (an in-flight
  // cloud-STT recording buffer, or the cloud-TTS port/queue). The two are ROUTED per-method by live
  // config, NOT stacked into one combined composite (which would couple them: a TTS-engine toggle
  // would tear down an in-flight STT recording, and vice versa). Each cloud layer wraps defaultEngine
  // directly; its cross-domain delegation is inert because the router only ever calls a layer for its
  // OWN domain.
  let cloudSttSingleton: VoiceEngineHandle | null = null
  let cloudTtsSingleton: VoiceEngineHandle | null = null
  const cloudStt = (): VoiceEngineHandle =>
    (cloudSttSingleton ??= createCloudSttEngine({
      local: defaultEngine(),
      transcribe,
      emit: emitTranscript,
      getSymbols: () => symbols.get()
    }))
  const cloudTts = (): VoiceEngineHandle =>
    (cloudTtsSingleton ??= createCloudTtsEngine({ local: defaultEngine(), speak }))
  // The engine serving THIS call for each domain: cloud when configured + keyed, else the local host.
  const sttDomain = (): VoiceEngineHandle => (useCloud() ? cloudStt() : defaultEngine())
  const ttsDomain = (): VoiceEngineHandle => (useCloudTts() ? cloudTts() : defaultEngine())
  // A stable router: STT methods dispatch to the STT domain, TTS methods to the TTS domain; wake /
  // failure / dispose go straight to the local host (the cloud layers delegate those to it anyway,
  // so registering on it directly is equivalent and never rebuilds a live session).
  const routerEngine: VoiceEngineHandle = {
    startSession: (port, model) => sttDomain().startSession(port, model),
    stopSession: (timeoutMs) => sttDomain().stopSession(timeoutMs),
    onEngineFailure: (cb) => defaultEngine().onEngineFailure(cb),
    startTtsSession: (port, model) => ttsDomain().startTtsSession(port, model),
    ttsSpeak: (req) => ttsDomain().ttsSpeak(req),
    ttsCancel: () => ttsDomain().ttsCancel(),
    stopTtsSession: () => ttsDomain().stopTtsSession(),
    onTtsFailure: (cb) => defaultEngine().onTtsFailure(cb),
    startKwsSession: (port, model) => defaultEngine().startKwsSession(port, model),
    stopKwsSession: (timeoutMs) => defaultEngine().stopKwsSession(timeoutMs),
    onKwsFailure: (cb) => defaultEngine().onKwsFailure(cb),
    dispose: () => {
      const stt = cloudSttSingleton
      const tts = cloudTtsSingleton
      cloudSttSingleton = null
      cloudTtsSingleton = null
      // Disposing either cloud layer also disposes the shared local host (they delegate dispose to
      // it — idempotent on a second call); fall back to the host directly when neither exists.
      if (stt) stt.dispose()
      if (tts) tts.dispose()
      if (!stt && !tts) defaultEngine().dispose()
    }
  }

  // Resolution order: explicit test injection → the e2e runtime stub (dormant null in every normal
  // run — only settable through e2eMain's gated registry) → the per-domain cloud router.
  const engine = (): VoiceEngineHandle => deps.engine ?? currentVoiceStubEngine() ?? routerEngine

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
  // Phase 2: whether the LIVE STT session runs on cloud. A cloud recording never touches the local
  // host (it holds the port + calls OpenAI), so a whole-host death — which onEngineFailure below
  // reacts to — is a TTS/KWS-only failure for a cloud session and must NOT restart/interrupt it.
  let liveIsCloud = false
  // J2 TTS session state. `hostFailureAlsoFails` lets the TTS block below observe a
  // WHOLE-host failure (which kills any TTS session too) without reordering this file —
  // it is assigned once the TTS handlers are registered.
  let ttsActive = false
  // Phase 3: whether the LIVE TTS session runs on cloud. A cloud speak never touches the local host
  // (it holds a MAIN-owned port + calls OpenAI), so a whole-host death is a STT/KWS/local-TTS-only
  // failure and must NOT fail the in-progress cloud speak.
  let ttsIsCloud = false
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
    // A dead host takes any live LOCAL TTS session with it — but a CLOUD TTS session runs off the
    // host (its own fetch + a MAIN-owned port), so a host death is not its failure.
    if (!ttsIsCloud) hostFailureAlsoFails?.(reason)
    // A cloud STT recording doesn't run on the host — a whole-host death is TTS/KWS-only and must
    // not tear down / restart the in-progress cloud session (it would truncate the transcription
    // and fire a spurious {kind:'restarted'} for a path that never broke). TTS already failed above.
    if (liveIsCloud) return
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
    // Cloud STT ignores the on-disk sherpa model entirely (it holds the port + calls OpenAI), so
    // report 'ready' (no Download CTA) and pass null paths — the cloud engine drops the model arg.
    const cloudActive = !deps.engine && !stubActive && useCloud()
    // V4: the configured model drives the session. An id missing from the catalog is
    // preserved on disk but falls back to the default here (scene-id discipline).
    const cfgModel = readVoiceConfig(userData).modelId
    const modelId = VOICE_MODEL_CATALOG.some((m) => m.id === cfgModel)
      ? cfgModel
      : DEFAULT_VOICE_MODEL_ID
    const status = stubActive || cloudActive ? 'ready' : await ops.status(userData, modelId)
    const paths =
      !stubActive && !cloudActive && status === 'ready' ? ops.paths(userData, modelId) : null
    liveModel = paths
    liveActive = true
    liveIsCloud = useCloud() // a cloud session is immune to the host-death restart (above)
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
    // The IPC download IS the explicit user gesture (Settings row) — verifyReady makes it
    // the repair path for size-preserving corruption of landed components (TTS-3).
    download: (userData, id, deps) => ttsOps.download(userData, id, deps, { verifyReady: true }),
    // Components of a model still downloading join the delete keep-set (TTS-2): deleting
    // the sibling mid-flight must not rm the shared espeak dir the install skipped.
    remove: (userData, id, inFlightIds) => ttsOps.remove(userData, id, { inFlightIds })
  })
  registerModelCatalogIpc(ipcMain, getWin, getUserData, {
    prefix: 'voice:kws:models',
    catalog: KWS_MODEL_CATALOG,
    defaultId: DEFAULT_KWS_MODEL_ID,
    status: kwsOps.status,
    download: (userData, id, deps) => kwsOps.download(userData, id, deps),
    remove: (userData, id, _inFlightIds) => kwsOps.remove(userData, id)
  })

  // ── J5 wake word (D3): the ONE sanctioned closed-panel listener. Renderer capture
  // frames flow over a dedicated voice:wake:port; a detection comes back on the same
  // port as {t:'wake', keyword}. MAIN never grants the mic — getUserMedia consent stays
  // renderer/OS-side; this only brokers the port and gates on the installed model.
  let wakeActive = false

  const onKwsFailure = (reason: string): void => {
    if (!wakeActive) return
    wakeActive = false
    getWin()?.webContents.send('voice:wake:event', {
      kind: 'error',
      reason
    } satisfies VoiceWakeEvent)
  }

  ipcMain.handle('voice:wake:start', async (e): Promise<VoiceWakeStartResult> => {
    if (isForeignSender(e, getWin) || !isVoicePlatformSupported()) {
      return { ok: false, modelStatus: 'absent' }
    }
    const win = getWin()
    if (!win) return { ok: false, modelStatus: 'absent' }
    const userData = getUserData()
    // Stub sessions are model-live by design (the spec fires the wake itself).
    const stubActive = !deps.engine && currentVoiceStubEngine() !== null
    const status = stubActive ? 'ready' : await kwsOps.status(userData, DEFAULT_KWS_MODEL_ID)
    // No degraded mode: a wake listener without a spotter hears nothing — fail fast and
    // let the Settings row drive the download CTA (the TTS posture).
    if (status !== 'ready') return { ok: false, modelStatus: status }
    const paths = stubActive ? null : kwsOps.paths(userData, DEFAULT_KWS_MODEL_ID)
    engine().onKwsFailure(onKwsFailure)
    const { port1, port2 } = new MessageChannelMain()
    engine().startKwsSession(port1, paths)
    win.webContents.postMessage('voice:wake:port', {}, [port2])
    wakeActive = true
    return { ok: true, modelStatus: status }
  })

  ipcMain.handle('voice:wake:stop', async (e): Promise<{ ok: boolean }> => {
    if (isForeignSender(e, getWin)) return { ok: false }
    wakeActive = false
    await engine().stopKwsSession()
    return { ok: true }
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
    // Cloud TTS synthesizes over the network — it needs NO on-disk model, so bypass the model-ready
    // gate (mirrors the cloud STT `cloudActive` bypass) and pass null paths (the cloud engine drops
    // them). The e2e stub keeps the real disk check; unit-test injection (deps.engine) does too.
    const stubActive = !deps.engine && currentVoiceStubEngine() !== null
    const cloudTts = !deps.engine && !stubActive && useCloudTts()
    const modelId = configuredTtsModelId()
    const status = cloudTts ? 'ready' : await ttsOps.status(userData, modelId)
    const paths = !cloudTts && status === 'ready' ? ttsOps.paths(userData, modelId) : null
    // No count-only degraded mode here (unlike STT): a LOCAL TTS session without a model has
    // nothing to stream — fail fast and let Settings drive the download CTA. Cloud needs no model.
    if (!cloudTts && !paths) return { ok: false, modelStatus: status }
    // Immunity tracks the CONFIG (mirrors STT's liveIsCloud = useCloud()), not the model-bypass gate,
    // so an injected test engine + cloud config is still treated as a cloud session.
    ttsIsCloud = useCloudTts()
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
    ttsIsCloud = false
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
    /** `inFlightIds` = the catalog's live download set at call time (TTS keep-set guard). */
    remove: (userData: string, id: string, inFlightIds: readonly string[]) => Promise<void>
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
        await cfg.remove(getUserData(), id, [...downloading])
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

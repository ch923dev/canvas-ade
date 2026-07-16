/**
 * Voice V2/V5 — engine host (utilityProcess entry).
 *
 * Runs in a full-Node utilityProcess forked by MAIN (`voiceEngine.ts`) so the sherpa-onnx
 * native addon (+ the onnxruntime shared libs beside it) loads OUTSIDE main — crash-
 * isolated, never anywhere near the renderer. Own electron-vite main-bundle entry
 * (`out/main/voiceEngineHost.js`). NO value imports from 'electron' here — a
 * utilityProcess has Node APIs + `process.parentPort` only.
 *
 * V5 — ASYNC INIT: recognizer construction (~70 MB of ONNX graphs; >10 s cold under
 * machine load — the V3 lesson) happens on a dedicated `worker_threads` decoder inside
 * this process, NEVER on the host message loop. The loop therefore always processes
 * `session:stop` promptly (the 30 s stopSession stopgap tightened back to 10 s in
 * voiceEngine.ts). Frames sent before the worker finished init simply queue in the
 * worker's message queue and decode when it's ready — nothing is dropped, nothing blocks.
 * The same worker owns the optional silero VAD (V5 endpoint accelerator).
 *
 * Contract (parentPort):
 *   boot            → OUT {t:'spike:result', ok, version, resolvedPath|error, workerOk} —
 *                     the addon load proof for BOTH contexts: the host's own resolution
 *                     (resolvedPath proves the asar-unpacked path when packaged) and the
 *                     decoder worker's load (proves worker_threads can reach the addon in
 *                     this layout). Consumed by the CANVAS_VOICE_SPIKE gate (V2 spike +
 *                     the V5 pack:dir smoke) and by voiceEngine.ts as the ready signal.
 *   IN  {t:'session:start', model: VoiceModelPaths|null} + ports[0]=session port
 *   IN  {t:'session:stop'} → posts {t:'stop'} on the session port (renderer releases the
 *                     mic), DRAINS the port (see eos below), then replies
 *                     OUT {t:'session:stopped', frames}.
 *   OUT {t:'decoder:error', error} — the decoder worker died (JS throw / exit). MAIN
 *                     treats this as an engine failure (voiceIpc restart-once policy).
 *
 * Session port (peer = the renderer's `voice:port` DOM port):
 *   IN  {t:'frame', d:ArrayBuffer} — 120 ms of 16 kHz mono Int16 PCM (V1 capture shape).
 *                     Frames are COUNTED on the host loop regardless of decoder state
 *                     (the V1 stub semantics the @voice e2e asserts) and forwarded to the
 *                     decoder worker when a session model is live.
 *   IN  {t:'eos'}   — the renderer's LAST message (sent on capture dispose). The stop
 *                     reply waits for this: port-vs-parentPort delivery order is NOT
 *                     guaranteed, so without an in-band sentinel a session:stop can be
 *                     processed before queued frames and under-count. Port messages ARE
 *                     ordered within the port → eos proves every frame before it was
 *                     counted. (With V5's async init the host loop no longer stalls, but
 *                     the in-band drain stays — it is what makes the count exact.)
 *   OUT {t:'partial', text} — greedy-search partial (only when text changed)
 *   OUT {t:'final', text}   — endpoint fired (sherpa rules OR the VAD accelerator);
 *                     stream reset.
 *   All session-port payloads are plain JSON — NEVER put a transferable in a cross-process
 *   port transfer list (Electron nulls the whole payload silently; see V1).
 *
 * J2 TTS seam (parentPort control; chunks flow over a SECOND MessagePort):
 *   IN  {t:'tts:session:start', ttsModel: TtsModelPaths|null} + ports[0]=tts port —
 *                     lazily spawns the TTS worker (own thread, same bundle) and builds
 *                     the OfflineTts there (createAsync >10 s cold — NEVER on this loop).
 *   IN  {t:'tts:speak', req: TtsSpeakReq} — FIFO into the worker's speak queue.
 *   IN  {t:'tts:cancel'} — barge-in: active synth cancels via onProgress-return-0, the
 *                     queue drains with {cancelled:true} dones.
 *   IN  {t:'tts:session:stop'} — cancel + close the tts port.
 *   OUT (tts port) TtsOutMsg — tts:chunk (Float32 PCM copy + sampleRate) / tts:done /
 *                     tts:error, streamed as sherpa finishes each sentence
 *                     (maxNumSentences:1 = sentence-chunked synthesis).
 *   OUT {t:'tts:engine:error', error} — TTS worker died or its session init failed. The
 *                     host stays up (STT unaffected); the next tts:session:start respawns.
 */
import { Worker, isMainThread, parentPort as nodeWorkerPort, workerData } from 'worker_threads'
import type { MessagePort as NodeMessagePort } from 'worker_threads'
import type { VoiceModelPaths } from './voiceModels'
import type { TtsModelPaths } from './voiceTtsModels'
import type { KwsModelPaths } from './voiceKwsModels'
import {
  createTtsRunner,
  evictAllBut,
  type OfflineTtsLike,
  type TtsOutMsg,
  type TtsRunner,
  type TtsSpeakReq
} from './voiceTtsRunner'
// Compat re-exports — the runner block moved to voiceTtsRunner.ts (max-lines ratchet);
// existing consumers (voiceEngine, the integration tests) keep importing from here.
export { clampSid, createTtsRunner, evictAllBut, floatToPcm16Base64 } from './voiceTtsRunner'
export type { OfflineTtsLike, TtsOutMsg, TtsRunner, TtsSpeakReq } from './voiceTtsRunner'

export interface SpikeResult {
  t: 'spike:result'
  ok: boolean
  version?: string
  /** Where `sherpa-onnx-node` actually resolved (proves the asar-unpacked path when packaged). */
  resolvedPath?: string
  /** V5: whether the decoder worker_thread ALSO loaded the addon (the async-init context). */
  workerOk?: boolean
  /** J1: whether the addon exposes OfflineTts in this layout (the TTS engine seam). */
  ttsOk?: boolean
  error?: string
}

/** Structural slice of sherpa's OnlineRecognizer/OnlineStream (unit-testable with fakes). */
export interface RecognizerLike {
  createStream(): StreamLike
  isReady(s: StreamLike): boolean
  decode(s: StreamLike): void
  isEndpoint(s: StreamLike): boolean
  reset(s: StreamLike): void
  getResult(s: StreamLike): { text: string }
}
export interface StreamLike {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void
}

/** Structural slice of sherpa's Vad (silero) — the V5 endpoint accelerator. */
export interface VadLike {
  acceptWaveform(samples: Float32Array): void
  isDetected(): boolean
}

export interface SessionPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  start(): void
  postMessage(msg: unknown): void
  close(): void
}

export function int16ToFloat32(buf: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buf)
  const out = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768
  return out
}

export interface FrameProcessor {
  push(frame: ArrayBuffer): void
  frames(): number
}

/** V1 capture frame duration — the VAD silence accumulator's tick size. */
export const FRAME_MS = 120
/**
 * VAD endpoint accelerator: once silero has closed the speech segment (its own
 * minSilenceDuration, ~0.5 s) and this much MORE silence accumulates while partial text
 * is pending, force the endpoint instead of waiting for sherpa's trailing-silence rules.
 * Total ~0.8 s from speech end → final, vs the 1.0–2.4 s rule fallback. Finals only ever
 * APPEND to the flyout draft (never submit — SPEC §2), so an over-eager final is harmless.
 */
export const VAD_FINALIZE_SILENCE_MS = 300

/**
 * The per-session decode loop, pure over RecognizerLike/VadLike so it unit-tests without
 * the addon. `recognizer === null` (model absent) degrades to frame counting only.
 * With a `vad`, sustained detected-silence while a partial is pending forces the endpoint
 * (the V5 accelerator); sherpa's own endpoint rules remain the fallback (and the only
 * trigger when the VAD model file is absent).
 */
export function createFrameProcessor(
  recognizer: RecognizerLike | null,
  post: (msg: { t: 'partial' | 'final'; text: string }) => void,
  opts: { vad?: VadLike | null; frameMs?: number; vadFinalizeMs?: number } = {}
): FrameProcessor {
  const stream = recognizer?.createStream() ?? null
  const vad = opts.vad ?? null
  const frameMs = opts.frameMs ?? FRAME_MS
  const vadFinalizeMs = opts.vadFinalizeMs ?? VAD_FINALIZE_SILENCE_MS
  let frames = 0
  let lastPartial = ''
  let vadSilentMs = 0
  return {
    frames: () => frames,
    push(frame: ArrayBuffer): void {
      frames++
      if (!recognizer || !stream) return
      const samples = int16ToFloat32(frame)
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      const text = recognizer.getResult(stream).text
      if (text && text !== lastPartial) {
        lastPartial = text
        post({ t: 'partial', text })
      }
      let endpoint = recognizer.isEndpoint(stream)
      if (vad) {
        vad.acceptWaveform(samples)
        if (vad.isDetected()) {
          vadSilentMs = 0
        } else {
          vadSilentMs += frameMs
          if (!endpoint && lastPartial && vadSilentMs >= vadFinalizeMs) endpoint = true
        }
      }
      if (endpoint) {
        if (text) post({ t: 'final', text })
        recognizer.reset(stream)
        lastPartial = ''
        vadSilentMs = 0
      }
    }
  }
}

// ── J2 TTS session (speak queue + chunk stream) ────────────────────────────────────────

/** Structural slice of sherpa's KeywordSpotter (J5 wake word — unit-testable with fakes).
 *  Same decode-loop shape as OnlineRecognizer; getResult().keyword is non-empty on a hit. */
export interface KeywordSpotterLike {
  createStream(): StreamLike
  isReady(s: StreamLike): boolean
  decode(s: StreamLike): void
  reset(s: StreamLike): void
  getResult(s: StreamLike): { keyword: string }
}

interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => RecognizerLike
  Vad: new (config: unknown, bufferSizeInSeconds: number) => VadLike
  OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsLike> }
  KeywordSpotter: new (config: unknown) => KeywordSpotterLike
  version: string
}

function loadAddon(): { mod: SherpaModule | null; result: Omit<SpikeResult, 't'> } {
  try {
    // Dynamic require so a load failure becomes a reportable result instead of a fork-time
    // crash. sherpa-onnx-node is CJS + externalized (the main bundle itself is CJS).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('sherpa-onnx-node')
    return {
      mod: mod as SherpaModule,
      result: {
        ok: typeof mod?.OnlineRecognizer === 'function',
        version: String(mod?.version ?? 'unknown'),
        resolvedPath: require.resolve('sherpa-onnx-node'),
        ttsOk: typeof mod?.OfflineTts === 'function'
      }
    }
  } catch (err) {
    return {
      mod: null,
      result: { ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }
    }
  }
}

export function buildRecognizerConfig(model: VoiceModelPaths): unknown {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
      tokens: model.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    // V5 endpoint tuning: rule2 (trailing silence AFTER decoded text) 1.2 → 1.0 s for
    // snappier finals; rule1 (silence with NO text) and rule3 (utterance cap) stay at the
    // example defaults. The silero VAD accelerator (when its model file is installed)
    // usually fires first at ~0.8 s — these rules are the fallback.
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.0,
    rule3MinUtteranceLength: 20
  }
}

/** Silero VAD config (V5). 512-sample windows are the silero v4 requirement at 16 kHz. */
export function buildVadConfig(vadModelPath: string): unknown {
  return {
    sileroVad: {
      model: vadModelPath,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      windowSize: 512,
      maxSpeechDuration: 20
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  }
}

/**
 * OfflineTts config (J1). Thread counts are spike-derived (scripts/tts-spike.mjs run
 * 2026-07-10 on target hardware): Kokoro fp32 needs 4 threads for sub-second first audio
 * (t1 is RTF>1 — unusable); Piper is ~10× realtime already at 2. NEVER int8 on CPU (D2 —
 * int8 is SLOWER than fp32 here). `maxNumSentences: 1` synthesizes sentence-by-sentence,
 * which is what makes generateAsync's onProgress a chunk stream (the J2 playback/barge-in
 * seam) instead of one blob at the end.
 */
export function buildTtsConfig(model: TtsModelPaths): unknown {
  const engine =
    model.engine === 'kokoro'
      ? {
          kokoro: {
            model: model.model,
            voices: model.voices ?? '',
            tokens: model.tokens,
            dataDir: model.dataDir
          },
          numThreads: 4
        }
      : {
          vits: { model: model.model, tokens: model.tokens, dataDir: model.dataDir },
          numThreads: 2
        }
  return {
    model: { ...engine, provider: 'cpu', debug: 0 },
    maxNumSentences: 1
  }
}

/** KeywordSpotter config (J5 D3). Spike-validated 2026-07-17 on the gigaspeech 3.3M
 *  int8 export: threshold 0.25 detected the SAPI-synthesized wake phrase with zero hits
 *  on negative speech at the production 120 ms frame size. */
export function buildKwsConfig(model: KwsModelPaths): unknown {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
      tokens: model.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0
    },
    maxActivePaths: 4,
    keywordsScore: 1.0,
    keywordsThreshold: 0.25,
    keywordsFile: model.keywords
  }
}

/**
 * The per-session wake-word decode loop, pure over KeywordSpotterLike so it unit-tests
 * without the addon (createFrameProcessor's sibling). A hit posts `{t:'wake', keyword}`
 * and resets the stream — the spotter keeps listening (MAIN decides what a wake does).
 */
export function createKwsProcessor(
  spotter: KeywordSpotterLike | null,
  post: (msg: { t: 'wake'; keyword: string }) => void
): FrameProcessor {
  const stream = spotter?.createStream() ?? null
  let frames = 0
  return {
    frames: () => frames,
    push(frame: ArrayBuffer): void {
      frames++
      if (!spotter || !stream) return
      stream.acceptWaveform({ samples: int16ToFloat32(frame), sampleRate: 16000 })
      while (spotter.isReady(stream)) {
        spotter.decode(stream)
        const r = spotter.getResult(stream)
        if (r.keyword) {
          post({ t: 'wake', keyword: r.keyword })
          spotter.reset(stream)
        }
      }
    }
  }
}

export interface SessionHandle {
  frames(): number
  /** Graceful stop: tell the renderer to release the mic, drain the port until its
   *  {t:'eos'} (or the timeout — renderer gone), then report the final frame count. */
  requestStop(onDone: (frames: number) => void, timeoutMs?: number): void
  /** Immediate teardown (session replacement / host dispose) — no count report. */
  endNow(): void
}

/**
 * One live session over its port: counts frames on the host loop, forwards them to the
 * decode `sink` (the worker client in production; null = count-only), answers the drain
 * protocol. Pure over the structural port type → unit-testable without electron.
 */
export function attachSession(
  port: SessionPortLike,
  sink: ((frame: ArrayBuffer) => void) | null,
  opts: { debug?: boolean; log?: (line: string) => void; now?: () => number } = {}
): SessionHandle {
  const log = opts.log ?? console.log
  const now = opts.now ?? Date.now
  let frames = 0
  let firstAt = 0
  let done = false
  let onEos: (() => void) | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null

  const finish = (onDone: (frames: number) => void): void => {
    if (done) return
    done = true
    if (drainTimer) clearTimeout(drainTimer)
    onDone(frames)
    port.close()
  }

  port.on('message', (e) => {
    const m = e.data as { t?: string; d?: unknown } | null
    if (m?.t === 'eos') {
      onEos?.()
      return
    }
    if (!m || m.t !== 'frame' || !(m.d instanceof ArrayBuffer)) return
    if (frames === 0) firstAt = now()
    frames++
    if (opts.debug && frames % 8 === 0) {
      const elapsedS = (now() - firstAt) / 1000
      const rate = elapsedS > 0 ? (frames - 1) / elapsedS : 0
      log(
        `[voice] host: ${frames} frames, ${rate.toFixed(1)}/s, ` +
          `${m.d.byteLength} B each, decode=${sink ? 'worker' : 'none'}`
      )
    }
    sink?.(m.d)
  })
  port.start()

  return {
    frames: () => frames,
    requestStop(onDone, timeoutMs = 1000): void {
      if (done) return
      try {
        port.postMessage({ t: 'stop' })
      } catch {
        /* renderer end gone — the timeout path reports whatever was counted */
      }
      onEos = () => finish(onDone)
      drainTimer = setTimeout(() => finish(onDone), timeoutMs)
    },
    endNow(): void {
      if (done) return
      done = true
      if (drainTimer) clearTimeout(drainTimer)
      try {
        port.postMessage({ t: 'stop' })
      } catch {
        /* renderer end gone */
      }
      port.close()
    }
  }
}

// ── V5 decoder worker (runs inside this same bundle, discriminated by workerData) ──────

/** Worker-bound message shapes (host → decoder thread). */
type DecoderInMsg = { t: 'session'; model: VoiceModelPaths | null } | { t: 'frame'; d: ArrayBuffer }

/**
 * The decoder thread body: owns the sherpa addon, the recognizer cache, and the VAD.
 * Everything blocking (recognizer construction, decode) happens HERE — the host loop
 * stays free. Messages process strictly in order, so frames posted before the 'session'
 * init finished simply queue and decode afterwards.
 */
function runDecoderWorker(parent: NodeMessagePort): void {
  const { mod, result } = loadAddon()
  parent.postMessage({ t: 'worker:ready', ok: result.ok, error: result.error })

  // Recognizer construction loads ~70 MB of ONNX graphs (1-2 s warm, >10 s cold under
  // load) — cache per model so toggling the mic doesn't re-pay it. Keyed by encoder path.
  const recognizerCache = new Map<string, RecognizerLike>()
  const vadCache = new Map<string, VadLike>()
  let proc: FrameProcessor | null = null

  const getRecognizer = (model: VoiceModelPaths): RecognizerLike | null => {
    if (!mod) return null
    const cached = recognizerCache.get(model.encoder)
    if (cached) return cached
    const rec = new mod.OnlineRecognizer(buildRecognizerConfig(model))
    recognizerCache.set(model.encoder, rec)
    return rec
  }
  const getVad = (path: string | undefined): VadLike | null => {
    if (!mod || !path) return null
    const cached = vadCache.get(path)
    if (cached) return cached
    try {
      const vad = new mod.Vad(buildVadConfig(path), 10)
      vadCache.set(path, vad)
      return vad
    } catch (err) {
      // VAD is an accelerator, not a requirement — degrade to the sherpa endpoint rules.
      console.error('[voice-decoder] silero VAD init failed (endpoint rules only):', err)
      return null
    }
  }

  parent.on('message', (m: DecoderInMsg) => {
    if (m?.t === 'session') {
      proc = null
      if (!m.model) {
        parent.postMessage({ t: 'session:ready', ok: true, live: false })
        return
      }
      try {
        const recognizer = getRecognizer(m.model)
        proc = createFrameProcessor(recognizer, (msg) => parent.postMessage(msg), {
          vad: getVad(m.model.vad)
        })
        // TTS-7 (STT side): a model SWITCH unpins the previous recognizer/VAD graphs
        // (~70 MB each) — only the live model stays cached for the mic-toggle fast path.
        evictAllBut(recognizerCache, m.model.encoder)
        evictAllBut(vadCache, m.model.vad)
        parent.postMessage({ t: 'session:ready', ok: true, live: recognizer !== null })
      } catch (err) {
        // Model files present but unloadable (corrupt/incompatible) → surface it; MAIN's
        // restart-once policy turns a repeat into the renderer's `error` state.
        const error = err instanceof Error ? err.message : String(err)
        console.error('[voice-decoder] recognizer init failed:', error)
        parent.postMessage({ t: 'session:ready', ok: false, error })
      }
    } else if (m?.t === 'frame' && m.d instanceof ArrayBuffer) {
      proc?.push(m.d)
    }
  })
}

// ── J5 KWS worker (same bundle, discriminated by workerData.role = 'voice-kws') ────────

/** Host → KWS worker messages. */
type KwsWorkerInMsg = { t: 'session'; model: KwsModelPaths | null } | { t: 'frame'; d: ArrayBuffer }

/**
 * The wake-word thread body: owns the sherpa addon + a KeywordSpotter cache (keyed by
 * encoder path — re-arming the listener on the same model skips re-construction).
 * Construction (~5 MB int8 graphs, well under a second) still runs HERE, never on the
 * host loop (the decoder-worker discipline). NOTE the keywords file is generated from a
 * fixed validated constant (voiceKwsModels) — a malformed one ABORTS the native process,
 * which the engine-failure escalation upstream treats as a host death.
 */
function runKwsWorker(parent: NodeMessagePort): void {
  const { mod, result } = loadAddon()
  const kwsOk = typeof mod?.KeywordSpotter === 'function'
  parent.postMessage({ t: 'worker:ready', ok: kwsOk, error: result.error })

  const spotterCache = new Map<string, KeywordSpotterLike>()
  let proc: FrameProcessor | null = null

  parent.on('message', (m: KwsWorkerInMsg) => {
    if (m?.t === 'session') {
      proc = null
      if (!m.model) {
        parent.postMessage({ t: 'session:ready', ok: true, live: false })
        return
      }
      if (!kwsOk || !mod) {
        // TTS-6 discipline: a requested model with no addon is a real failure, not a degrade.
        parent.postMessage({
          t: 'session:ready',
          ok: false,
          error: `kws addon unavailable: ${result.error ?? 'sherpa load failed'}`
        })
        return
      }
      try {
        const cached = spotterCache.get(m.model.encoder)
        const spotter = cached ?? new mod.KeywordSpotter(buildKwsConfig(m.model))
        spotterCache.set(m.model.encoder, spotter)
        evictAllBut(spotterCache, m.model.encoder) // TTS-7 discipline
        proc = createKwsProcessor(spotter, (msg) => parent.postMessage(msg))
        parent.postMessage({ t: 'session:ready', ok: true, live: true })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error('[voice-kws] spotter init failed:', error)
        parent.postMessage({ t: 'session:ready', ok: false, error })
      }
    } else if (m?.t === 'frame' && m.d instanceof ArrayBuffer) {
      proc?.push(m.d)
    }
  })
}

// ── J2 TTS worker (same bundle, discriminated by workerData.role = 'voice-tts') ────────

/** Host → TTS worker messages. */
type TtsWorkerInMsg =
  | { t: 'session'; model: TtsModelPaths | null }
  | { t: 'speak'; req: TtsSpeakReq }
  | { t: 'cancel' }

/**
 * The TTS thread body: owns the sherpa addon + an OfflineTts cache (keyed by model path —
 * re-opening a session on the same model skips the multi-second createAsync). Everything
 * long-running (createAsync — >10 s cold under load, the V3 lesson — and synthesis)
 * happens HERE, never on the host loop. Speaks/cancels chain through the init promise so
 * a request arriving mid-createAsync executes against the session it targeted, in order.
 */
function runTtsWorker(parent: NodeMessagePort): void {
  const { mod, result } = loadAddon()
  parent.postMessage({ t: 'worker:ready', ok: !!result.ttsOk, error: result.error })

  const ttsCache = new Map<string, OfflineTtsLike>()
  const post = (m: TtsOutMsg): void => parent.postMessage(m)
  let runner: Promise<TtsRunner> = Promise.resolve(createTtsRunner(null, post))

  parent.on('message', (m: TtsWorkerInMsg) => {
    if (m?.t === 'session') {
      const model = m.model
      const prev = runner
      runner = (async () => {
        ;(await prev).cancel() // a session swap never leaves the old queue speaking
        if (!model) {
          parent.postMessage({ t: 'session:ready', ok: true, live: false })
          return createTtsRunner(null, post)
        }
        if (!mod?.OfflineTts) {
          // TTS-6: a model was requested but the ADDON failed to load — a real failure,
          // not the designed no-model degrade. ok:false escalates through the host's
          // session:ready handler → MAIN's tts error event, instead of the renderer
          // misdiagnosing it as "model not loaded" (STT's count-only degrade has no
          // TTS equivalent — a session without an engine has nothing to stream).
          parent.postMessage({
            t: 'session:ready',
            ok: false,
            error: `tts addon unavailable: ${result.error ?? 'sherpa load failed'}`
          })
          return createTtsRunner(null, post)
        }
        try {
          const cached = ttsCache.get(model.model)
          const tts = cached ?? (await mod.OfflineTts.createAsync(buildTtsConfig(model)))
          ttsCache.set(model.model, tts)
          evictAllBut(ttsCache, model.model) // TTS-7: the previous model's graph unpins
          parent.postMessage({
            t: 'session:ready',
            ok: true,
            live: true,
            sampleRate: tts.sampleRate
          })
          return createTtsRunner(tts, post)
        } catch (err) {
          // Model files present but unloadable — surface it; MAIN pushes the renderer's
          // tts error event. The null runner answers any queued speaks with tts:error.
          const error = err instanceof Error ? err.message : String(err)
          console.error('[voice-tts] OfflineTts init failed:', error)
          parent.postMessage({ t: 'session:ready', ok: false, error })
          return createTtsRunner(null, post)
        }
      })()
    } else if (m?.t === 'speak') {
      void runner.then((r) => r.speak(m.req))
    } else if (m?.t === 'cancel') {
      void runner.then((r) => r.cancel())
    }
  })
}

/** Host-side client for the decoder thread. */
interface DecoderClient {
  ready: Promise<{ ok: boolean; error?: string }>
  session(model: VoiceModelPaths | null): void
  push(frame: ArrayBuffer): void
}

function createDecoderWorker(
  onTranscript: (msg: { t: 'partial' | 'final'; text: string }) => void,
  onFailRaw: (reason: string) => void
): DecoderClient {
  // A worker 'error' is followed by its 'exit' — escalate the failure exactly once.
  let failedOnce = false
  const onFail = (reason: string): void => {
    if (failedOnce) return
    failedOnce = true
    onFailRaw(reason)
  }
  const worker = new Worker(__filename, { workerData: { role: 'voice-decoder' } })
  let resolveReady!: (r: { ok: boolean; error?: string }) => void
  let readySettled = false
  const ready = new Promise<{ ok: boolean; error?: string }>((r) => {
    resolveReady = (v) => {
      if (readySettled) return
      readySettled = true
      r(v)
    }
  })
  worker.on('message', (m: { t?: string; ok?: boolean; error?: string; text?: string }) => {
    if (m?.t === 'worker:ready') resolveReady({ ok: !!m.ok, error: m.error })
    else if (m?.t === 'session:ready') {
      if (!m.ok) onFail(`decoder session init failed: ${m.error ?? 'unknown'}`)
    } else if ((m?.t === 'partial' || m?.t === 'final') && typeof m.text === 'string') {
      onTranscript({ t: m.t, text: m.text })
    }
  })
  worker.on('error', (err) => {
    const reason = `decoder worker error: ${err instanceof Error ? err.message : String(err)}`
    resolveReady({ ok: false, error: reason })
    onFail(reason)
  })
  worker.on('exit', (code) => {
    const reason = `decoder worker exited (${code})`
    resolveReady({ ok: false, error: reason })
    onFail(reason)
  })
  return {
    ready,
    session: (model) => worker.postMessage({ t: 'session', model } satisfies DecoderInMsg),
    // COPY, do not transfer: the same buffer was just counted on the host loop, and a
    // same-process structured-clone copy at ~32 KB/s is noise (mirrors the V1 renderer→
    // MAIN discipline; keeps every consumer of the buffer order-independent).
    push: (frame) => worker.postMessage({ t: 'frame', d: frame } satisfies DecoderInMsg)
  }
}

// ── utilityProcess main (skipped under vitest, which has no parentPort) ────────────────
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown; ports: SessionPortLike[] }) => void): unknown
  postMessage(msg: unknown): void
}
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

// Role dispatch: the decoder worker re-enters THIS bundle with workerData.role set (so no
// extra vite entry is needed). vitest also runs test files inside worker_threads, but its
// workerData never carries our role marker — the guard stays side-effect free there.
const workerRole = (workerData as { role?: string } | null)?.role

if (!isMainThread && workerRole === 'voice-decoder' && nodeWorkerPort) {
  runDecoderWorker(nodeWorkerPort)
} else if (!isMainThread && workerRole === 'voice-tts' && nodeWorkerPort) {
  runTtsWorker(nodeWorkerPort)
} else if (!isMainThread && workerRole === 'voice-kws' && nodeWorkerPort) {
  runKwsWorker(nodeWorkerPort)
} else if (parentPort) {
  const debug = !!process.env.CANVAS_VOICE_DEBUG
  let session: SessionHandle | null = null
  let sessionPort: SessionPortLike | null = null

  // Host-side load = the resolution/resolvedPath proof; decode lives in the worker.
  const { result: hostAddon } = loadAddon()
  const decoder = createDecoderWorker(
    (msg) => {
      try {
        sessionPort?.postMessage(msg)
      } catch {
        /* renderer end gone — partials have nowhere to go */
      }
    },
    (reason) => {
      try {
        parentPort.postMessage({ t: 'decoder:error', error: reason })
      } catch {
        /* parent gone — the host is being torn down anyway */
      }
    }
  )

  void decoder.ready.then((w) => {
    parentPort.postMessage({
      t: 'spike:result',
      ok: hostAddon.ok && w.ok,
      version: hostAddon.version,
      resolvedPath: hostAddon.resolvedPath,
      workerOk: w.ok,
      ttsOk: hostAddon.ttsOk,
      error: hostAddon.error ?? w.error
    } satisfies SpikeResult)
  })

  // ── J2 TTS session: lazy worker (spawned on the first tts session start — non-Jarvis
  // sessions never pay the second addon load), respawned by the next start after a death.
  // Chunks flow host → renderer over the TTS port; control arrives via parentPort.
  let ttsPort: SessionPortLike | null = null
  let ttsWorker: Worker | null = null

  const postTtsFailure = (error: string): void => {
    try {
      parentPort.postMessage({ t: 'tts:engine:error', error })
    } catch {
      /* parent gone — the host is being torn down anyway */
    }
  }
  const ensureTtsWorker = (): Worker => {
    if (ttsWorker) return ttsWorker
    const w = new Worker(__filename, { workerData: { role: 'voice-tts' } })
    w.on('message', (m: { t?: string; ok?: boolean; error?: string } | null) => {
      if (m?.t === 'tts:chunk' || m?.t === 'tts:done' || m?.t === 'tts:error') {
        try {
          ttsPort?.postMessage(m)
        } catch {
          /* renderer end gone — chunks have nowhere to go */
        }
      } else if (m?.t === 'session:ready' && !m.ok) {
        postTtsFailure(`tts session init failed: ${m.error ?? 'unknown'}`)
      }
    })
    // Worker death: clear the handle (the next tts:session:start respawns clean) and
    // escalate — MAIN pushes the renderer's voice:tts:event. The identity guard keeps a
    // replaced worker's exit from clobbering its successor. STT is untouched: unlike the
    // decoder worker, a dead TTS thread never degrades dictation, so the host stays up.
    const fail = (reason: string): void => {
      if (ttsWorker !== w) return
      ttsWorker = null
      postTtsFailure(reason)
    }
    w.on('error', (err) =>
      fail(`tts worker error: ${err instanceof Error ? err.message : String(err)}`)
    )
    w.on('exit', (code) => fail(`tts worker exited (${code})`))
    ttsWorker = w
    return w
  }

  // ── J5 KWS session: lazy worker (spawned on the first wake-word arm — sessions that
  // never use the wake word never pay the third addon load), respawned after a death.
  // Frames arrive renderer → kws port → host (attachSession) → worker; a detection flows
  // back worker → host → kws port ({t:'wake', keyword}). STT/TTS are untouched by a KWS
  // worker death — the host stays up, MAIN gets kws:engine:error and re-arms lazily.
  let kwsPort: SessionPortLike | null = null
  let kwsSession: SessionHandle | null = null
  let kwsWorker: Worker | null = null

  const postKwsFailure = (error: string): void => {
    try {
      parentPort.postMessage({ t: 'kws:engine:error', error })
    } catch {
      /* parent gone — the host is being torn down anyway */
    }
  }
  const ensureKwsWorker = (): Worker => {
    if (kwsWorker) return kwsWorker
    const w = new Worker(__filename, { workerData: { role: 'voice-kws' } })
    w.on('message', (m: { t?: string; ok?: boolean; error?: string; keyword?: string } | null) => {
      if (m?.t === 'wake') {
        try {
          kwsPort?.postMessage(m)
        } catch {
          /* renderer end gone — the wake has nowhere to go */
        }
      } else if (m?.t === 'session:ready' && !m.ok) {
        postKwsFailure(`kws session init failed: ${m.error ?? 'unknown'}`)
      }
    })
    const fail = (reason: string): void => {
      if (kwsWorker !== w) return
      kwsWorker = null
      postKwsFailure(reason)
    }
    w.on('error', (err) =>
      fail(`kws worker error: ${err instanceof Error ? err.message : String(err)}`)
    )
    w.on('exit', (code) => fail(`kws worker exited (${code})`))
    kwsWorker = w
    return w
  }

  parentPort.on('message', (e) => {
    const m = e.data as {
      t?: string
      model?: VoiceModelPaths | null
      ttsModel?: TtsModelPaths | null
      kwsModel?: KwsModelPaths | null
      req?: TtsSpeakReq
    } | null
    if (m?.t === 'session:start' && e.ports[0]) {
      session?.endNow() // restart-idempotent: a second start replaces the live session
      const model = m.model ?? null
      decoder.session(model)
      sessionPort = e.ports[0]
      session = attachSession(e.ports[0], model ? (f) => decoder.push(f) : null, { debug })
    } else if (m?.t === 'session:stop') {
      const s = session
      session = null
      if (!s) {
        parentPort.postMessage({ t: 'session:stopped', frames: 0 })
        return
      }
      s.requestStop((frames) => parentPort.postMessage({ t: 'session:stopped', frames }))
    } else if (m?.t === 'tts:session:start' && e.ports[0]) {
      try {
        ttsPort?.close() // restart-idempotent, like session:start
      } catch {
        /* already gone */
      }
      ttsPort = e.ports[0]
      ttsPort.start() // renderer never posts on this port today; started for symmetry
      ensureTtsWorker().postMessage({ t: 'session', model: m.ttsModel ?? null })
    } else if (m?.t === 'tts:speak' && m.req) {
      ttsWorker?.postMessage({ t: 'speak', req: m.req })
    } else if (m?.t === 'tts:cancel') {
      ttsWorker?.postMessage({ t: 'cancel' })
    } else if (m?.t === 'tts:session:stop') {
      ttsWorker?.postMessage({ t: 'cancel' })
      try {
        ttsPort?.close()
      } catch {
        /* already gone */
      }
      ttsPort = null
    } else if (m?.t === 'kws:session:start' && e.ports[0]) {
      kwsSession?.endNow() // restart-idempotent, like session:start
      const model = m.kwsModel ?? null
      const worker = ensureKwsWorker()
      worker.postMessage({ t: 'session', model } satisfies KwsWorkerInMsg)
      kwsPort = e.ports[0]
      kwsSession = attachSession(
        e.ports[0],
        model ? (f) => worker.postMessage({ t: 'frame', d: f } satisfies KwsWorkerInMsg) : null,
        { debug }
      )
    } else if (m?.t === 'kws:session:stop') {
      const s = kwsSession
      kwsSession = null
      kwsPort = null
      if (!s) {
        parentPort.postMessage({ t: 'kws:session:stopped', frames: 0 })
        return
      }
      s.requestStop((frames) => parentPort.postMessage({ t: 'kws:session:stopped', frames }))
    }
  })
}

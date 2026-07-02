/**
 * Voice V2 — engine host (utilityProcess entry).
 *
 * Runs in a full-Node utilityProcess forked by MAIN (`voiceEngine.ts`) so the sherpa-onnx
 * native addon (+ the onnxruntime shared libs beside it) loads OUTSIDE main — crash-
 * isolated, never anywhere near the renderer. Own electron-vite main-bundle entry
 * (`out/main/voiceEngineHost.js`). NO value imports from 'electron' here — a
 * utilityProcess has Node APIs + `process.parentPort` only.
 *
 * Contract (parentPort):
 *   boot            → OUT {t:'spike:result', ok, version, resolvedPath|error} — the addon
 *                     load proof. Consumed by the CANVAS_VOICE_SPIKE gate (V2 spike,
 *                     PASSED 2026-07-02 win-x64 dev+packaged: resolution goes through
 *                     app.asar, the .node auto-redirects to app.asar.unpacked — no custom
 *                     loader needed on Windows) and by voiceEngine.ts as the ready signal.
 *   IN  {t:'session:start', model: VoiceModelPaths|null} + ports[0]=session port
 *   IN  {t:'session:stop'} → posts {t:'stop'} on the session port (renderer releases the
 *                     mic), DRAINS the port (see eos below), then replies
 *                     OUT {t:'session:stopped', frames}.
 *
 * Session port (peer = the renderer's `voice:port` DOM port):
 *   IN  {t:'frame', d:ArrayBuffer} — 120 ms of 16 kHz mono Int16 PCM (V1 capture shape).
 *                     Frames are COUNTED regardless of model state (the V1 stub semantics
 *                     the @voice e2e asserts); when a recognizer is live they also feed
 *                     the streaming decode loop.
 *   IN  {t:'eos'}   — the renderer's LAST message (sent on capture dispose). The stop
 *                     reply waits for this: port-vs-parentPort delivery order is NOT
 *                     guaranteed, so without an in-band sentinel a session:stop can be
 *                     processed before queued frames (seen when a cold recognizer init
 *                     blocks the host loop) and under-count. Port messages ARE ordered
 *                     within the port → eos proves every frame before it was counted.
 *   OUT {t:'partial', text} — greedy-search partial (only when text changed)
 *   OUT {t:'final', text}   — endpoint fired (rule1 2.4 s / rule2 1.2 s); stream reset.
 *   All session-port payloads are plain JSON — NEVER put a transferable in a cross-process
 *   port transfer list (Electron nulls the whole payload silently; see V1).
 */
import type { VoiceModelPaths } from './voiceModels'

export interface SpikeResult {
  t: 'spike:result'
  ok: boolean
  version?: string
  /** Where `sherpa-onnx-node` actually resolved (proves the asar-unpacked path when packaged). */
  resolvedPath?: string
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

/**
 * The per-session decode loop, pure over RecognizerLike so it unit-tests without the
 * addon. `recognizer === null` (model absent) degrades to frame counting only.
 */
export function createFrameProcessor(
  recognizer: RecognizerLike | null,
  post: (msg: { t: 'partial' | 'final'; text: string }) => void
): FrameProcessor {
  const stream = recognizer?.createStream() ?? null
  let frames = 0
  let lastPartial = ''
  return {
    frames: () => frames,
    push(frame: ArrayBuffer): void {
      frames++
      if (!recognizer || !stream) return
      stream.acceptWaveform({ samples: int16ToFloat32(frame), sampleRate: 16000 })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      const text = recognizer.getResult(stream).text
      if (text && text !== lastPartial) {
        lastPartial = text
        post({ t: 'partial', text })
      }
      if (recognizer.isEndpoint(stream)) {
        if (text) post({ t: 'final', text })
        recognizer.reset(stream)
        lastPartial = ''
      }
    }
  }
}

interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => RecognizerLike
  version: string
}

let sherpa: SherpaModule | null = null

function loadAddon(): SpikeResult {
  try {
    // Dynamic require so a load failure becomes a reportable result instead of a fork-time
    // crash. sherpa-onnx-node is CJS + externalized (the main bundle itself is CJS).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('sherpa-onnx-node')
    sherpa = mod as SherpaModule
    return {
      t: 'spike:result',
      ok: typeof mod?.OnlineRecognizer === 'function',
      version: String(mod?.version ?? 'unknown'),
      resolvedPath: require.resolve('sherpa-onnx-node')
    }
  } catch (err) {
    return {
      t: 'spike:result',
      ok: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    }
  }
}

// Recognizer construction loads ~70 MB of ONNX graphs (1-2 s) — cache per model so
// toggling the mic doesn't re-pay it. Keyed by encoder path (unique per model install).
const recognizerCache = new Map<string, RecognizerLike>()

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
    // Plan V2 endpoint rules (example defaults; tuned in V5).
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20
  }
}

function getRecognizer(model: VoiceModelPaths | null): RecognizerLike | null {
  if (!model || !sherpa) return null
  const cached = recognizerCache.get(model.encoder)
  if (cached) return cached
  const rec = new sherpa.OnlineRecognizer(buildRecognizerConfig(model))
  recognizerCache.set(model.encoder, rec)
  return rec
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
 * One live session over its port: counts/decodes frames, answers the drain protocol.
 * Pure over the structural port/recognizer types → unit-testable without electron.
 */
export function attachSession(
  port: SessionPortLike,
  recognizer: RecognizerLike | null,
  opts: { debug?: boolean; log?: (line: string) => void; now?: () => number } = {}
): SessionHandle {
  const log = opts.log ?? console.log
  const now = opts.now ?? Date.now
  const proc = createFrameProcessor(recognizer, (msg) => {
    try {
      port.postMessage(msg)
    } catch {
      /* renderer end gone — partials have nowhere to go */
    }
  })
  let firstAt = 0
  let done = false
  let onEos: (() => void) | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null

  const finish = (onDone: (frames: number) => void): void => {
    if (done) return
    done = true
    if (drainTimer) clearTimeout(drainTimer)
    onDone(proc.frames())
    port.close()
  }

  port.on('message', (e) => {
    const m = e.data as { t?: string; d?: unknown } | null
    if (m?.t === 'eos') {
      onEos?.()
      return
    }
    if (!m || m.t !== 'frame' || !(m.d instanceof ArrayBuffer)) return
    if (proc.frames() === 0) firstAt = now()
    proc.push(m.d)
    if (opts.debug && proc.frames() % 8 === 0) {
      const elapsedS = (now() - firstAt) / 1000
      const rate = elapsedS > 0 ? (proc.frames() - 1) / elapsedS : 0
      log(
        `[voice] host: ${proc.frames()} frames, ${rate.toFixed(1)}/s, ` +
          `${m.d.byteLength} B each, model=${recognizer ? 'live' : 'none'}`
      )
    }
  })
  port.start()

  return {
    frames: () => proc.frames(),
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

// ── utilityProcess main (skipped under vitest, which has no parentPort) ────────────────
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown; ports: SessionPortLike[] }) => void): unknown
  postMessage(msg: unknown): void
}
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

if (parentPort) {
  const debug = !!process.env.CANVAS_VOICE_DEBUG
  let session: SessionHandle | null = null

  parentPort.on('message', (e) => {
    const m = e.data as { t?: string; model?: VoiceModelPaths | null } | null
    if (m?.t === 'session:start' && e.ports[0]) {
      session?.endNow() // restart-idempotent: a second start replaces the live session
      let recognizer: RecognizerLike | null = null
      try {
        recognizer = getRecognizer(m.model ?? null)
      } catch (err) {
        // Model files present but unloadable (corrupt/incompatible) → degrade to
        // counting; MAIN sees modelStatus 'ready' but no partials. V5 hardens this
        // into a surfaced error state.
        console.error('[voice-engine] recognizer init failed:', err)
      }
      session = attachSession(e.ports[0], recognizer, { debug })
    } else if (m?.t === 'session:stop') {
      const s = session
      session = null
      if (!s) {
        parentPort.postMessage({ t: 'session:stopped', frames: 0 })
        return
      }
      s.requestStop((frames) => parentPort.postMessage({ t: 'session:stopped', frames }))
    }
  })

  parentPort.postMessage(loadAddon())
}

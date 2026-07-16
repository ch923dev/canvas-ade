/**
 * Jarvis J2/J5 — the pure TTS speak-queue runner + shared host-cache helpers, extracted
 * from voiceEngineHost.ts (max-lines ratchet — the J5 KWS worker pushed the host entry
 * over the pin; voiceBoot/jarvisBoot precedent, pure move, no behavior change). Nothing
 * here touches the sherpa addon: OfflineTtsLike is structural, so everything unit-tests
 * with fakes (voiceEngineHost.tts.test.ts). The worker bodies stay in voiceEngineHost —
 * they re-enter that bundle entry by __filename.
 */

/**
 * Structural slice of sherpa's OfflineTts (J1). `generateAsync` streams sentence chunks
 * via onProgress on a background thread; returning 0/false from onProgress CANCELS the
 * remaining synthesis — the J2 barge-in flush hook. NOTE: the callback receives ONE
 * `{samples, progress}` info object (sherpa-onnx-node non-streaming-tts.js wraps the
 * addon callback), NOT two positional args — a positional signature still fires and
 * still cancels, but `new Float32Array(infoObject)` is length 0, so every chunk goes
 * out EMPTY (found live in the J2 dev check; the probe test guards it now).
 */
export interface OfflineTtsLike {
  sampleRate: number
  numSpeakers: number
  generateAsync(req: {
    text: string
    sid: number
    speed: number
    /** MUST be false under Electron: the default (true) returns the final audio as a
     *  napi EXTERNAL arraybuffer, which Electron's caged Node forbids — the addon's
     *  completion throws "External buffers are not allowed" and kills the worker
     *  thread after every finished utterance (found live in the J2 dev check). */
    enableExternalBuffer?: boolean
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean
  }): Promise<{ samples: Float32Array; sampleRate: number }>
}

/** One speak request (id assigned by MAIN's voice:tts:speak handler; executed FIFO). */
export interface TtsSpeakReq {
  id: number
  text: string
  sid: number
  speed: number
}

/**
 * TTS worker/host → renderer payloads over the TTS session port. Plain JSON ONLY — the
 * V1 port discipline, and here it is load-bearing twice over: a transferable in a
 * cross-process port transfer list nulls the whole payload (V1), and in Electron's
 * caged Node an ArrayBuffer payload posted from a worker_thread throws
 * "External buffers are not allowed" and KILLS the worker (found live in the J2 dev
 * check — every utterance crashed the worker and its OfflineTts cache with it). `pcm16`
 * is base64-encoded 16-bit little-endian mono PCM at `sampleRate` (chunks self-describe
 * the rate — Kokoro 24 kHz vs Piper 22.05 kHz); 16-bit matches the WAV assets we ship.
 */
export type TtsOutMsg =
  | { t: 'tts:chunk'; id: number; seq: number; sampleRate: number; pcm16: string }
  | { t: 'tts:done'; id: number; cancelled: boolean }
  | { t: 'tts:error'; id: number; error: string }

/** Float32 [-1,1] → base64(PCM16LE) — the port-safe chunk encoding. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return Buffer.from(pcm.buffer).toString('base64')
}

/**
 * TTS-5: bound the speaker id to the LIVE engine's speaker count — a config switch
 * mid-session (Kokoro sid 47 → single-speaker Piper) must never push an out-of-range
 * index into the native addon. A non-positive/garbled count passes the sid through
 * (some engines report 0 for single-speaker models — the addon treats any sid as 0 there).
 */
export function clampSid(sid: number, numSpeakers: number): number {
  if (!Number.isInteger(numSpeakers) || numSpeakers <= 0) return sid
  return Math.max(0, Math.min(sid, numSpeakers - 1))
}

/**
 * TTS-7: drop every cache entry except `keep` — the model just switched, and a pinned
 * previous recognizer/OfflineTts is ~hundreds of MB of native ONNX graphs (including
 * models since deleted from disk). Dropping the ref lets the addon finalizer free it;
 * an in-flight synthesis keeps its own ref until it settles, so eviction never races it.
 */
export function evictAllBut<K, V>(cache: Map<K, V>, keep: K | undefined): number {
  let evicted = 0
  for (const k of [...cache.keys()]) {
    if (k !== keep) {
      cache.delete(k)
      evicted++
    }
  }
  return evicted
}

export interface TtsRunner {
  /** Enqueue a speak; requests synthesize serially (J3's brain streams one clause each). */
  speak(req: TtsSpeakReq): void
  /** Barge-in flush: cancel the ACTIVE synthesis (next onProgress returns 0 — sherpa
   *  drops the remaining sentences) and drain the queue, closing every id with
   *  `{cancelled:true}` so the renderer's ledger settles. */
  cancel(): void
}

/**
 * The per-session speak queue, pure over OfflineTtsLike so it unit-tests without the
 * addon. `tts === null` (model absent / init failed) answers every speak with a
 * `tts:error` instead of synthesizing — MAIN gates sessions on model status, so this is
 * a defensive rail, not a mode.
 */
export function createTtsRunner(
  tts: OfflineTtsLike | null,
  post: (m: TtsOutMsg) => void
): TtsRunner {
  const queue: TtsSpeakReq[] = []
  let running = false
  let epoch = 0
  const drain = async (): Promise<void> => {
    if (running) return
    running = true
    while (queue.length > 0) {
      const req = queue.shift()!
      const myEpoch = epoch
      let seq = 0
      try {
        await tts!.generateAsync({
          text: req.text,
          sid: clampSid(req.sid, tts!.numSpeakers),
          speed: req.speed,
          enableExternalBuffer: false, // Electron cage — see OfflineTtsLike
          onProgress: (info) => {
            if (epoch !== myEpoch) return 0 // cancel remaining synthesis (barge-in)
            // Encode to a plain string IN the callback: the Float32Array views native
            // memory the engine reuses after this frame returns, and only JSON-safe
            // payloads survive the worker→host→port hops (see TtsOutMsg).
            post({
              t: 'tts:chunk',
              id: req.id,
              seq: seq++,
              sampleRate: tts!.sampleRate,
              pcm16: floatToPcm16Base64(info.samples)
            })
            return 1
          }
        })
        post({ t: 'tts:done', id: req.id, cancelled: epoch !== myEpoch })
      } catch (err) {
        post({
          t: 'tts:error',
          id: req.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    running = false
  }
  return {
    speak(req: TtsSpeakReq): void {
      if (!tts) {
        post({ t: 'tts:error', id: req.id, error: 'tts model not loaded' })
        return
      }
      queue.push(req)
      void drain()
    },
    cancel(): void {
      epoch++
      for (const q of queue) post({ t: 'tts:done', id: q.id, cancelled: true })
      queue.length = 0
    }
  }
}

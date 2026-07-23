/**
 * Voice cloud TTS — the composite VoiceEngineHandle (MAIN, in-process; no utilityProcess, so the
 * OpenAI key never crosses a process boundary). Phase 3 twin of cloudSttEngine.ts: it WRAPS the
 * local sherpa/Kokoro handle and overrides ONLY the five TTS methods (startTtsSession / ttsSpeak /
 * ttsCancel / stopTtsSession / onTtsFailure); STT + wake-word + engine-failure + dispose delegate
 * straight through, untouched.
 *
 * DELIVERY IS THE SAME PORT the local host uses. voiceIpc brokers a voice:tts:port
 * MessageChannelMain and hands the MAIN end here; this engine posts the exact TtsOutMsg shapes the
 * renderer's ttsPlayback already consumes (tts:chunk / tts:done / tts:error). No out-of-band
 * side-channel is needed (unlike cloud STT) because TTS is push MAIN→renderer over a port that
 * stays open for the whole session.
 *
 * SYNTHESIS: on ttsSpeak(req) → openaiSpeak POSTs /v1/audio/speech and STREAMS pcm back; each even
 * (16-bit-aligned) run is base64-encoded and posted as one tts:chunk at 24 kHz. Requests run FIFO
 * and SERIALLY (mirroring the local runner — one fetch at a time, in order, so overlapping speaks
 * queue rather than interleave; a multi-clause utterance still plays whole). ttsCancel is the
 * barge-in flush: it bumps the epoch (stops emitting the current stream), ABORTS the in-flight
 * fetch, and drains the queue with cancelled dones so the renderer's ledger settles.
 */
import type { MessagePortMain } from 'electron'
import type { VoiceModelPaths } from './voiceModels'
import type { TtsModelPaths } from './voiceTtsModels'
import type { VoiceEngineHandle } from './voiceEngine'
import type { TtsOutMsg, TtsSpeakReq } from './voiceTtsRunner'
import { CloudSpeakError, type CloudSpeak } from './openaiSpeak'

/** OpenAI /v1/audio/speech `pcm` is always 24 kHz mono; the chunk self-declares it for playback. */
const OPENAI_PCM_SAMPLE_RATE = 24_000

export interface CloudTtsDeps {
  /** The wrapped local handle: STT/KWS/failure/dispose delegate to it; TTS is overridden here. */
  local: VoiceEngineHandle
  /** text → streamed PCM (openaiSpeak; injectable for tests). */
  speak: CloudSpeak
  /** Override the declared chunk sample rate (default 24 kHz — OpenAI pcm). */
  sampleRate?: number
}

export function createCloudTtsEngine(deps: CloudTtsDeps): VoiceEngineHandle {
  const { local, speak } = deps
  const sampleRate = deps.sampleRate ?? OPENAI_PCM_SAMPLE_RATE
  let port: MessagePortMain | null = null
  const queue: TtsSpeakReq[] = []
  let running = false
  // Barge-in / stop / dispose bump this; a synthesis whose epoch changed stops emitting and settles
  // as cancelled (mirrors the local runner's epoch cancel).
  let epoch = 0
  let currentAbort: AbortController | null = null

  const post = (m: TtsOutMsg): void => {
    try {
      port?.postMessage(m)
    } catch {
      /* port already gone (session stopped) */
    }
  }

  const drain = async (): Promise<void> => {
    if (running) return
    running = true
    while (queue.length > 0) {
      const req = queue.shift()!
      const myEpoch = epoch
      let seq = 0
      const ac = new AbortController()
      currentAbort = ac
      try {
        await speak({
          text: req.text,
          signal: ac.signal,
          onAudio: (pcm) => {
            if (epoch !== myEpoch) return // barge-in mid-stream — drop the rest
            post({
              t: 'tts:chunk',
              id: req.id,
              seq: seq++,
              sampleRate,
              pcm16: Buffer.from(pcm).toString('base64')
            })
          }
        })
        post({ t: 'tts:done', id: req.id, cancelled: epoch !== myEpoch })
      } catch (err) {
        // An abort (external cancel) or a superseding epoch is a cancel, not a fail-visible error.
        const aborted = (err as { name?: string })?.name === 'AbortError'
        if (aborted || epoch !== myEpoch) {
          post({ t: 'tts:done', id: req.id, cancelled: true })
        } else {
          const error = err instanceof CloudSpeakError ? err.reason : 'network'
          post({ t: 'tts:error', id: req.id, error })
        }
      } finally {
        if (currentAbort === ac) currentAbort = null
      }
    }
    running = false
  }

  /** Bump the epoch + abort any in-flight fetch (barge-in / stop / dispose). */
  const cancelActive = (): void => {
    epoch++
    currentAbort?.abort()
  }

  return {
    // ── TTS: cloud-overridden ──
    startTtsSession(p: MessagePortMain, _model: TtsModelPaths | null): void {
      // Re-broker-idempotent like the host: adopt the new port, drop any prior one. Cloud ignores
      // the on-disk model arg (it synthesizes over the network).
      if (port && port !== p) {
        try {
          port.close()
        } catch {
          /* already closed */
        }
      }
      port = p
    },
    ttsSpeak(req: TtsSpeakReq): void {
      queue.push(req)
      void drain()
    },
    ttsCancel(): void {
      cancelActive()
      // Drain the queue: every not-yet-started speak settles cancelled so the renderer ledger clears.
      for (const q of queue) post({ t: 'tts:done', id: q.id, cancelled: true })
      queue.length = 0
    },
    stopTtsSession(): void {
      cancelActive()
      queue.length = 0
      if (port) {
        try {
          port.close()
        } catch {
          /* already closed */
        }
        port = null
      }
    },
    // Cloud TTS failures surface per-utterance as tts:error on the port (above), NOT this. This still
    // delegates so an STT/KWS consumer keeps observing the LOCAL host's TTS-worker lifecycle.
    onTtsFailure(cb): void {
      local.onTtsFailure(cb)
    },
    // ── STT + wake-word + failure: unchanged, straight delegation to the wrapped local host ──
    startSession(port2: MessagePortMain, model: VoiceModelPaths | null): void {
      local.startSession(port2, model)
    },
    stopSession(timeoutMs?: number): Promise<{ frames: number }> {
      return local.stopSession(timeoutMs)
    },
    onEngineFailure(cb): void {
      local.onEngineFailure(cb)
    },
    startKwsSession(port2, model): void {
      local.startKwsSession(port2, model)
    },
    stopKwsSession(timeoutMs): Promise<{ frames: number }> {
      return local.stopKwsSession(timeoutMs)
    },
    onKwsFailure(cb): void {
      local.onKwsFailure(cb)
    },
    dispose(): void {
      cancelActive()
      queue.length = 0
      if (port) {
        try {
          port.close()
        } catch {
          /* already closed */
        }
        port = null
      }
      local.dispose()
    }
  }
}

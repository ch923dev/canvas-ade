/**
 * Voice cloud TTS — the OpenAI /v1/audio/speech call (MAIN only). Twin of openaiTranscribe.ts,
 * TTS-side: a JSON POST that STREAMS audio back. response_format is `pcm` (Phase 3 decision) —
 * OpenAI returns headerless 24 kHz signed-16-bit little-endian MONO PCM, which is byte-identical
 * to the tts:chunk payload the renderer already plays (base64 PCM16LE @ a self-declared rate), so
 * the cloud path reuses the existing playback queue with no decoder and no resample.
 *
 * SECURITY (never weaken): the API key lives ONLY in the `getKey` closure this factory captures —
 * read MAIN-side, written straight onto the Authorization header, never returned, logged, or passed
 * to the renderer / a child process / a board. The renderer sees key PRESENCE (hasKey) only. The
 * transport is injectable so unit tests never hit the network; synthesized audio is streamed to the
 * caller in-memory and never touches disk.
 */

/** Minimal fetch surface (JSON body + a streamed audio body) — global `fetch` in Electron MAIN
 *  satisfies it (undici's Response.body is async-iterable); tests inject a fake with an async
 *  generator body. Kept structural so a fake needs only ok/status/body/text(). */
export type SpeakFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<SpeakResponse>

export interface SpeakResponse {
  ok: boolean
  status: number
  /** The streamed audio body (undici ReadableStream is async-iterable). Read only on the ok path;
   *  null is tolerated (an error response carries its detail in text()). */
  body: AsyncIterable<Uint8Array> | null
  text(): Promise<string>
}

/** Why a synthesis failed, mapped to fail-visible renderer copy by the cloud engine. Same map as
 *  the STT twin (openaiTranscribe) — an external cancel is NOT here (it re-throws AbortError so the
 *  engine settles the utterance as `cancelled`, not `error`). */
export type SpeakErrorReason =
  | 'no-key'
  | 'unauthorized'
  | 'rate-limited'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad-response'

export class CloudSpeakError extends Error {
  reason: SpeakErrorReason
  status?: number
  constructor(reason: SpeakErrorReason, message: string, status?: number) {
    super(message)
    this.name = 'CloudSpeakError'
    this.reason = reason
    this.status = status
  }
}

export interface CloudSpeakInput {
  /** The utterance text (MAIN clamps to ≤2000 chars before this). */
  text: string
  /** Called per streamed PCM run — ALWAYS an even byte length (16-bit-sample aligned). */
  onAudio: (pcm: Uint8Array) => void
  /** Barge-in / supersede: the engine aborts this to cancel an in-flight synthesis. An abort from
   *  this signal re-throws AbortError (a cancel, not a fail); the internal timeout maps to `timeout`. */
  signal?: AbortSignal
}

/** The speak seam the cloud engine calls on ttsSpeak: text → streamed PCM via onAudio. */
export type CloudSpeak = (input: CloudSpeakInput) => Promise<void>

export interface OpenAiSpeakDeps {
  /** Store-first MAIN-side key resolver (keyForProvider('openai', …)). undefined ⇒ no-key. */
  getKey: () => string | undefined
  /** Configured cloud TTS model (default gpt-4o-mini-tts), read fresh per call. */
  getModel: () => string
  /** Configured voice (alloy/echo/fable/onyx/nova/shimmer …), read fresh per call. */
  getVoice: () => string
  /** Overridable base URL — lets the e2e fake vendor slot in (shares CANVAS_VOICE_OPENAI_BASE). */
  getBaseUrl?: () => string
  /** Injectable transport; defaults to global fetch (undici) in MAIN. */
  fetch?: SpeakFetch
  /** Abort a hung vendor call (default 30 s) so a speak can't wedge on the network. */
  timeoutMs?: number
}

const DEFAULT_BASE = 'https://api.openai.com/v1'

/** Combine the caller's cancel signal with the internal timeout signal. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') return any(signals)
  const ac = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ac.abort()
      break
    }
    s.addEventListener('abort', () => ac.abort(), { once: true })
  }
  return ac.signal
}

export function createOpenAiSpeak(deps: OpenAiSpeakDeps): CloudSpeak {
  const doFetch: SpeakFetch = deps.fetch ?? (globalThis.fetch as unknown as SpeakFetch)
  const timeoutMs = deps.timeoutMs ?? 30_000
  const base = (): string => (deps.getBaseUrl?.() || DEFAULT_BASE).replace(/\/+$/, '')

  return async ({ text, onAudio, signal }): Promise<void> => {
    const key = deps.getKey()
    if (!key) throw new CloudSpeakError('no-key', 'OpenAI API key not set')

    // pcm: headerless 24 kHz s16le mono — matches the renderer's chunk format exactly.
    const body = JSON.stringify({
      model: deps.getModel(),
      input: text,
      voice: deps.getVoice(),
      response_format: 'pcm'
    })

    const timeoutAc = new AbortController()
    const timer = setTimeout(() => timeoutAc.abort(), timeoutMs)
    const combined = signal ? anySignal([signal, timeoutAc.signal]) : timeoutAc.signal

    let res: SpeakResponse
    try {
      res = await doFetch(`${base()}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: combined
      })
    } catch (err) {
      clearTimeout(timer)
      const e = err as { name?: string; message?: string }
      if (timeoutAc.signal.aborted) {
        throw new CloudSpeakError('timeout', `speech timed out after ${timeoutMs}ms`)
      }
      if (e?.name === 'AbortError') throw err // external cancel — the engine settles as cancelled
      throw new CloudSpeakError('network', `network error: ${e?.message ?? String(err)}`)
    }

    if (!res.ok) {
      clearTimeout(timer)
      const errBody = await res.text().catch(() => '')
      throw new CloudSpeakError(
        classifyStatus(res.status, errBody),
        `HTTP ${res.status}`,
        res.status
      )
    }

    // Stream PCM, preserving 16-bit-sample alignment across network-chunk boundaries: a chunk can
    // split a sample, so stash a trailing odd byte and prepend it to the next chunk. onAudio only
    // ever sees whole samples (even byte length).
    let carry: Uint8Array | null = null
    try {
      if (res.body) {
        for await (const part of res.body) {
          const bytes = part instanceof Uint8Array ? part : new Uint8Array(part as ArrayBuffer)
          let chunk = bytes
          if (carry && carry.length) {
            const joined = new Uint8Array(carry.length + bytes.length)
            joined.set(carry)
            joined.set(bytes, carry.length)
            chunk = joined
            carry = null
          }
          const even = chunk.length - (chunk.length % 2)
          if (even < chunk.length) carry = chunk.slice(even) // copy out the leftover byte
          if (even > 0) onAudio(chunk.subarray(0, even))
        }
      }
    } catch (err) {
      const e = err as { name?: string; message?: string }
      if (timeoutAc.signal.aborted) {
        throw new CloudSpeakError('timeout', `speech stream timed out after ${timeoutMs}ms`)
      }
      if (e?.name === 'AbortError') throw err // external cancel mid-stream
      throw new CloudSpeakError('network', `stream error: ${e?.message ?? String(err)}`)
    } finally {
      clearTimeout(timer)
    }
    // A well-formed PCM16 stream is even-length; any leftover carry byte has no whole sample to
    // play and is dropped.
  }
}

/** Map an HTTP status (+ body hint) to a fail-visible reason (identical policy to the STT twin). */
function classifyStatus(status: number, body: string): SpeakErrorReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402 || /insufficient_quota|exceeded your current quota/i.test(body)) return 'quota'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server'
  return 'bad-response'
}

/**
 * Voice cloud STT — the OpenAI /v1/audio/transcriptions call (MAIN only). Byte-for-byte the
 * request the Phase 1.5 harness measured at 85.5% keyterm-exact (scripts/stt-eval/engines/
 * openaiShape.mjs): multipart file + gpt-4o-transcribe + response_format json + temperature 0
 * + language en + the `prompt` biasing string (last-224-token glossary, capped upstream at 30).
 *
 * SECURITY (never weaken): the API key lives ONLY in the `getKey` closure this factory captures
 * — it is read MAIN-side, written straight onto the Authorization header, and never returned,
 * logged, or passed to the renderer / a child process / a board. The renderer sees key PRESENCE
 * (hasKey) only. The transport is injectable so unit tests never hit the network.
 */

/** Minimal fetch surface (multipart body) — global `fetch` in Electron MAIN satisfies it;
 *  tests inject a fake. Kept structural so a fake needs only `ok`/`status`/`text()`. */
export type TranscribeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Why a transcription failed, mapped to fail-visible renderer copy by the cloud engine. */
export type TranscribeErrorReason =
  | 'no-key'
  | 'unauthorized'
  | 'rate-limited'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad-response'

export class CloudTranscribeError extends Error {
  reason: TranscribeErrorReason
  status?: number
  constructor(reason: TranscribeErrorReason, message: string, status?: number) {
    super(message)
    this.name = 'CloudTranscribeError'
    this.reason = reason
    this.status = status
  }
}

export interface CloudTranscribeInput {
  /** Assembled 16 kHz mono WAV of the held utterance. */
  wav: Buffer
  /** Top-30 repo symbols for the biasing prompt (already capped by the symbol provider). */
  keyterms: readonly string[]
}

/** The transcribe seam the cloud engine calls on {t:'eos'}: WAV + bias → raw transcript. */
export type CloudTranscribe = (input: CloudTranscribeInput) => Promise<string>

export interface OpenAiTranscribeDeps {
  /** Store-first MAIN-side key resolver (keyForProvider('openai', …)). undefined ⇒ no-key. */
  getKey: () => string | undefined
  /** Configured STT model (default gpt-4o-transcribe), read fresh per call. */
  getModel: () => string
  /** Overridable base URL — lets the e2e fake vendor slot in (STT_EVAL_OPENAI_BASE analog). */
  getBaseUrl?: () => string
  /** Injectable transport; defaults to global fetch (undici multipart) in MAIN. */
  fetch?: TranscribeFetch
  /** Abort a hung vendor call (default 30 s) so a session can't wedge on the network. */
  timeoutMs?: number
}

const DEFAULT_BASE = 'https://api.openai.com/v1'

/**
 * Whisper-lineage models read the prompt as a continuation of prior speech, not an
 * instruction — a bare comma-joined list is the shape the OpenAI cookbook recommends.
 */
function promptFor(keyterms: readonly string[]): string | undefined {
  const terms = keyterms.filter((t) => typeof t === 'string' && t.trim())
  if (!terms.length) return undefined
  return `Technical vocabulary: ${terms.join(', ')}.`
}

export function createOpenAiTranscribe(deps: OpenAiTranscribeDeps): CloudTranscribe {
  const doFetch: TranscribeFetch = deps.fetch ?? (globalThis.fetch as unknown as TranscribeFetch)
  const timeoutMs = deps.timeoutMs ?? 30_000
  const base = (): string => (deps.getBaseUrl?.() || DEFAULT_BASE).replace(/\/+$/, '')

  return async ({ wav, keyterms }): Promise<string> => {
    const key = deps.getKey()
    if (!key) throw new CloudTranscribeError('no-key', 'OpenAI API key not set')

    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav')
    fd.append('model', deps.getModel())
    fd.append('response_format', 'json')
    // Greedy decode: sampling adds run-to-run variance unrelated to accuracy (the harness posture).
    fd.append('temperature', '0')
    fd.append('language', 'en')
    const prompt = promptFor(keyterms)
    if (prompt) fd.append('prompt', prompt)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res: { ok: boolean; status: number; text(): Promise<string> }
    try {
      res = await doFetch(`${base()}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: ac.signal
      })
    } catch (err) {
      const e = err as { name?: string; message?: string }
      if (e?.name === 'AbortError') {
        throw new CloudTranscribeError('timeout', `transcription timed out after ${timeoutMs}ms`)
      }
      throw new CloudTranscribeError('network', `network error: ${e?.message ?? String(err)}`)
    } finally {
      clearTimeout(timer)
    }

    const body = await res.text()
    if (!res.ok) {
      throw new CloudTranscribeError(
        classifyStatus(res.status, body),
        `HTTP ${res.status}`,
        res.status
      )
    }
    let json: { text?: unknown }
    try {
      json = JSON.parse(body) as { text?: unknown }
    } catch {
      throw new CloudTranscribeError('bad-response', 'response was not JSON')
    }
    if (typeof json.text !== 'string') {
      throw new CloudTranscribeError('bad-response', 'no text in transcription response')
    }
    return json.text.trim()
  }
}

/** Map an HTTP status (+ body hint) to a fail-visible reason. */
function classifyStatus(status: number, body: string): TranscribeErrorReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402 || /insufficient_quota|exceeded your current quota/i.test(body)) return 'quota'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server'
  return 'bad-response'
}

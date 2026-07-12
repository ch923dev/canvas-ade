/**
 * Jarvis J3 — the streaming brain (PLAN §3.4, KICKOFF-J3 §2). Deliberately NOT the
 * @anthropic-ai/sdk: the repo's LLM pattern (llmService.ts) is a hand-built Messages-API
 * request behind an injected transport, and this module extends that with `stream: true`
 * + an incremental SSE parser — zero new deps, unit-testable with a fake byte stream,
 * same CANVAS_LLM_MOCK seam so e2e never egresses. Key material never leaves this module:
 * errors surface as opaque `provider HTTP <status>` strings (llmService BUG-003 rule).
 */
import type { JarvisContentBlock, JarvisMessage } from './jarvisPersona'

/** Anthropic requires max_tokens; replies are spoken-short by contract. */
const REPLY_MAX_TOKENS = 1024
/** Abort a stream that stays silent this long (hung endpoint → typed error, no wedge). */
const STREAM_STALL_TIMEOUT_MS = 60_000

export interface JarvisRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** Pure: map (model, key, system, messages) → the exact streaming HTTP request. */
export function buildJarvisRequest(
  model: string,
  key: string,
  system: JarvisContentBlock[],
  messages: JarvisMessage[]
): JarvisRequest {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: REPLY_MAX_TOKENS,
      stream: true,
      system,
      messages
    })
  }
}

/** The SSE events this consumer cares about (everything else — ping, message_start,
 *  content_block_start/stop — is skipped). */
export type SseEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'stop' }
  | { kind: 'error'; message: string }

/**
 * Incremental SSE parser: feed raw chunks, get parsed events. Frames are separated by a
 * blank line; a frame's `data:` lines carry one JSON payload. Pure + stateful (carries
 * the cross-chunk remainder), so unit tests drive it with arbitrary chunk splits.
 */
export function createSseParser(): { push: (chunk: string) => SseEvent[] } {
  let buf = ''
  const parseFrame = (frame: string): SseEvent | null => {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') return null
    let j: Record<string, unknown>
    try {
      j = JSON.parse(data) as Record<string, unknown>
    } catch {
      return null // partial/garbled frame — skip, never throw mid-stream
    }
    if (j.type === 'content_block_delta') {
      const delta = j.delta as { type?: string; text?: string } | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return { kind: 'delta', text: delta.text }
      }
      return null
    }
    if (j.type === 'message_stop') return { kind: 'stop' }
    if (j.type === 'error') {
      const err = j.error as { message?: string; type?: string } | undefined
      // Opaque-ish: the API error type is safe; the message may quote request detail,
      // so surface the type only (BUG-003 discipline).
      return { kind: 'error', message: `stream error: ${err?.type ?? 'unknown'}` }
    }
    return null
  }
  return {
    push(chunk: string): SseEvent[] {
      buf += chunk.replace(/\r\n/g, '\n')
      const events: SseEvent[] = []
      let idx = buf.indexOf('\n\n')
      while (idx >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseFrame(frame)
        if (ev) events.push(ev)
        idx = buf.indexOf('\n\n')
      }
      return events
    }
  }
}

/** Streaming transport seam: like llmService's FetchLike but exposing the byte stream. */
export type StreamFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null }>

export interface JarvisStreamDeps {
  fetch: StreamFetchLike
  env: Record<string, string | undefined>
}

/** Typed, never-throws stream result (SummarizeResult discipline; travels over IPC). */
export type JarvisStreamResult =
  | { ok: true; text: string; cancelled: boolean }
  | { ok: false; reason: 'no-key' }
  | { ok: false; reason: 'provider-error'; message: string }

export function isJarvisMockEnabled(env: Record<string, string | undefined>): boolean {
  return env.CANVAS_LLM_MOCK === '1'
}

/** Deterministic two-sentence mock reply (exercises the clause chunker end to end). */
export function mockJarvisReply(userText: string): string {
  const echo = userText.trim().slice(0, 60)
  return `Understood: ${echo}. This is the mock brain speaking, at your service.`
}

/**
 * Run one streaming turn. `onDelta` fires per text delta; the resolved result carries the
 * full text. An abort via `signal` is a SUCCESSFUL cancelled turn (barge-in), not an error.
 */
export async function streamJarvisReply(
  req: JarvisRequest,
  deps: JarvisStreamDeps,
  signal: AbortSignal,
  onDelta: (text: string) => void
): Promise<JarvisStreamResult> {
  if (isJarvisMockEnabled(deps.env)) {
    // Two deltas so consumers see real streaming behavior without egress.
    const full = mockJarvisReply(extractLastUserText(req))
    const mid = Math.ceil(full.length / 2)
    for (const piece of [full.slice(0, mid), full.slice(mid)]) {
      if (signal.aborted) return { ok: true, text: full.slice(0, mid), cancelled: true }
      onDelta(piece)
      await new Promise((r) => setTimeout(r, 10))
    }
    return { ok: true, text: full, cancelled: signal.aborted }
  }
  let text = ''
  try {
    // Stall watchdog composed onto the caller's barge-in signal.
    const stall = new AbortController()
    const timer = setTimeout(() => stall.abort(), STREAM_STALL_TIMEOUT_MS)
    const onOuterAbort = (): void => stall.abort()
    signal.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const res = await deps.fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        signal: stall.signal
      })
      // BUG-003: never surface the response body — it can echo request/key detail.
      if (!res.ok)
        return { ok: false, reason: 'provider-error', message: `anthropic HTTP ${res.status}` }
      if (!res.body)
        return { ok: false, reason: 'provider-error', message: 'anthropic: empty stream' }
      const parser = createSseParser()
      const decoder = new TextDecoder()
      for await (const chunk of res.body) {
        if (signal.aborted) return { ok: true, text, cancelled: true }
        clearTimeout(timer)
        for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) {
          if (ev.kind === 'delta') {
            text += ev.text
            onDelta(ev.text)
          } else if (ev.kind === 'error') {
            return { ok: false, reason: 'provider-error', message: ev.message }
          } else if (ev.kind === 'stop') {
            return { ok: true, text, cancelled: false }
          }
        }
      }
      return { ok: true, text, cancelled: signal.aborted }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuterAbort)
    }
  } catch (err) {
    if (signal.aborted) return { ok: true, text, cancelled: true }
    return {
      ok: false,
      reason: 'provider-error',
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Mock helper: pull the last user message text back out of the built request body. */
function extractLastUserText(req: JarvisRequest): string {
  try {
    const body = JSON.parse(req.body) as { messages?: { role: string; content: string }[] }
    const users = (body.messages ?? []).filter((m) => m.role === 'user')
    return users.length > 0 ? users[users.length - 1].content : ''
  } catch {
    return ''
  }
}

/** Default transport: Electron/Node global fetch — `res.body` (web ReadableStream) is
 *  async-iterable on Node ≥18, so no adapter beyond the shape cast. */
export const defaultJarvisDeps = (): JarvisStreamDeps => ({
  fetch: (async (url, init) => {
    const res = await fetch(url, init)
    return {
      ok: res.ok,
      status: res.status,
      body: res.body as unknown as AsyncIterable<Uint8Array> | null
    }
  }) as StreamFetchLike,
  env: process.env as Record<string, string | undefined>
})

/**
 * Jarvis J3 — the streaming brain (PLAN §3.4, KICKOFF-J3 §2). Deliberately NOT the
 * @anthropic-ai/sdk: the repo's LLM pattern (llmService.ts) is a hand-built Messages-API
 * request behind an injected transport, and this module extends that with `stream: true`
 * + an incremental SSE parser — zero new deps, unit-testable with a fake byte stream,
 * same CANVAS_LLM_MOCK seam so e2e never egresses. Key material never leaves this module:
 * errors surface as opaque `provider HTTP <status>` strings (llmService BUG-003 rule).
 *
 * J4 (hands): the parser also understands `tool_use` content blocks (content_block_start /
 * input_json_delta / content_block_stop) and the `message_delta` stop_reason, so one stream
 * yields BOTH the spoken text deltas and the assembled tool calls. The multi-hop loop
 * (execute tools → append tool_result → stream again) lives in jarvisIpc; this module stays
 * one-request-in / one-parsed-stream-out.
 */
import type { JarvisContentBlock, JarvisMessage } from './jarvisPersona'
import type { JarvisToolDef } from './jarvisTools'

/** Anthropic requires max_tokens; replies are spoken-short by contract. */
const REPLY_MAX_TOKENS = 1024
/** Abort a stream that stays silent this long (hung endpoint → typed error, no wedge). */
const STREAM_STALL_TIMEOUT_MS = 60_000

export interface JarvisRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** Pure: map (model, key, system, messages[, tools]) → the exact streaming HTTP request. */
export function buildJarvisRequest(
  model: string,
  key: string,
  system: JarvisContentBlock[],
  messages: JarvisMessage[],
  tools?: JarvisToolDef[]
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
      messages,
      ...(tools && tools.length > 0 ? { tools } : {})
    })
  }
}

/** The SSE events this consumer cares about (everything else — ping, message_start — is
 *  skipped). J4 adds the tool_use block family + the message_delta stop_reason. */
export type SseEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_start'; id: string; name: string }
  | { kind: 'tool_input'; partial: string }
  | { kind: 'tool_stop' }
  | { kind: 'stop_reason'; reason: string }
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
    if (j.type === 'content_block_start') {
      const block = j.content_block as { type?: string; id?: string; name?: string } | undefined
      if (
        block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        return { kind: 'tool_start', id: block.id, name: block.name }
      }
      return null
    }
    if (j.type === 'content_block_delta') {
      const delta = j.delta as { type?: string; text?: string; partial_json?: string } | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return { kind: 'delta', text: delta.text }
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        return { kind: 'tool_input', partial: delta.partial_json }
      }
      return null
    }
    if (j.type === 'content_block_stop') return { kind: 'tool_stop' }
    if (j.type === 'message_delta') {
      const delta = j.delta as { stop_reason?: string } | undefined
      if (typeof delta?.stop_reason === 'string') {
        return { kind: 'stop_reason', reason: delta.stop_reason }
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
  /** Test seam: override the per-chunk stall watchdog (default STREAM_STALL_TIMEOUT_MS). */
  stallTimeoutMs?: number
}

/** One assembled tool call from the stream (input already JSON-parsed; {} on garble —
 *  the executor's validation rejects an empty input for tools that need arguments). */
export interface JarvisToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

/** Typed, never-throws stream result (SummarizeResult discipline; travels over IPC). */
export type JarvisStreamResult =
  | {
      ok: true
      text: string
      cancelled: boolean
      toolUses: JarvisToolUse[]
      stopReason: string | null
    }
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

/** The mock's scripted turn: text, optionally followed by ONE tool call (J4 e2e). */
export interface MockTurn {
  text: string
  toolUse?: JarvisToolUse
}

/**
 * J4 mock script (CANVAS_LLM_MOCK): a deterministic mini-grammar over the last user
 * message so the @voice e2e can drive a REAL tool call — through the real validator,
 * the real confirm gate and the real orchestrator — with zero egress.
 *   "add a card <title> to board <id>"  → add_card (confirm-gated end to end)
 *   "focus board <id>"                  → focus_viewport (the auto-allow read tier)
 * A turn whose last message carries tool_result blocks answers GROUNDED in that result
 * (echoes its content), so the spec can assert the spoken confirmation quotes the tool
 * outcome and never a fabricated status.
 */
export function mockJarvisTurn(req: JarvisRequest): MockTurn {
  const last = extractLastUserMessage(req)
  if (last.toolResults.length > 0) {
    const r = last.toolResults[0]
    const head = r.content.trim().slice(0, 120)
    return {
      text: r.isError
        ? `That did not go through: ${head}. Nothing was changed.`
        : `Done. The tool reported: ${head}.`
    }
  }
  const text = last.text.trim()
  const addCard = /^add a card (?:called |titled )?"?(.+?)"? (?:to|on) (?:the )?board (\S+)$/i.exec(
    text
  )
  if (addCard) {
    return {
      text: 'One card coming up.',
      toolUse: {
        id: 'mock-tool-1',
        name: 'add_card',
        input: { board: addCard[2], title: addCard[1] }
      }
    }
  }
  const focus = /^focus (?:the )?board (\S+)$/i.exec(text)
  if (focus) {
    return {
      text: 'Focusing.',
      toolUse: { id: 'mock-tool-1', name: 'focus_viewport', input: { board: focus[1] } }
    }
  }
  return { text: mockJarvisReply(text) }
}

/**
 * Run one streaming turn. `onDelta` fires per text delta; the resolved result carries the
 * full text plus any assembled tool calls. An abort via `signal` is a SUCCESSFUL cancelled
 * turn (barge-in), not an error.
 */
export async function streamJarvisReply(
  req: JarvisRequest,
  deps: JarvisStreamDeps,
  signal: AbortSignal,
  onDelta: (text: string) => void
): Promise<JarvisStreamResult> {
  // BRAIN-1: an abort listener attached to an ALREADY-aborted signal never fires, and the
  // caller awaits (manifest/getAppModel — seconds on first turn) before reaching here. A
  // barge-in landing in that window must not still issue the full paid request.
  if (signal.aborted) return { ok: true, text: '', cancelled: true, toolUses: [], stopReason: null }
  if (isJarvisMockEnabled(deps.env)) {
    // Two deltas so consumers see real streaming behavior without egress.
    const turn = mockJarvisTurn(req)
    const full = turn.text
    const mid = Math.ceil(full.length / 2)
    for (const piece of [full.slice(0, mid), full.slice(mid)]) {
      if (signal.aborted) {
        return {
          ok: true,
          text: full.slice(0, mid),
          cancelled: true,
          toolUses: [],
          stopReason: null
        }
      }
      onDelta(piece)
      await new Promise((r) => setTimeout(r, 10))
    }
    return {
      ok: true,
      text: full,
      cancelled: signal.aborted,
      toolUses: turn.toolUse && !signal.aborted ? [turn.toolUse] : [],
      stopReason: turn.toolUse && !signal.aborted ? 'tool_use' : 'end_turn'
    }
  }
  let text = ''
  const toolUses: JarvisToolUse[] = []
  let pendingTool: { id: string; name: string; json: string } | null = null
  let stopReason: string | null = null
  const settleTool = (): void => {
    if (!pendingTool) return
    let input: Record<string, unknown> = {}
    try {
      const parsed: unknown = pendingTool.json.trim() ? JSON.parse(pendingTool.json) : {}
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>
      }
    } catch {
      input = {} // garbled tool input — the executor's validation surfaces it to the model
    }
    toolUses.push({ id: pendingTool.id, name: pendingTool.name, input })
    pendingTool = null
  }
  // Stall watchdog composed onto the caller's barge-in signal. Re-armed on EVERY
  // received chunk (review finding on PR #339): a one-shot timer only guarded
  // time-to-first-byte — a server that goes silent MID-stream without closing would
  // otherwise hang the `for await` forever. `stalled` types the reason (BRAIN-3): the
  // catch below must tell a watchdog abort from a transport throw.
  const stall = new AbortController()
  let stalled = false
  try {
    const stallMs = deps.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS
    const fireStall = (): void => {
      stalled = true
      stall.abort()
    }
    let timer = setTimeout(fireStall, stallMs)
    const rearm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(fireStall, stallMs)
    }
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
        if (signal.aborted) return { ok: true, text, cancelled: true, toolUses: [], stopReason }
        rearm()
        for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) {
          if (ev.kind === 'delta') {
            text += ev.text
            onDelta(ev.text)
          } else if (ev.kind === 'tool_start') {
            pendingTool = { id: ev.id, name: ev.name, json: '' }
          } else if (ev.kind === 'tool_input') {
            if (pendingTool) pendingTool.json += ev.partial
          } else if (ev.kind === 'tool_stop') {
            settleTool()
          } else if (ev.kind === 'stop_reason') {
            stopReason = ev.reason
          } else if (ev.kind === 'error') {
            return { ok: false, reason: 'provider-error', message: ev.message }
          } else if (ev.kind === 'stop') {
            settleTool() // belt-and-braces: a stream ending without content_block_stop
            return { ok: true, text, cancelled: false, toolUses, stopReason }
          }
        }
      }
      settleTool()
      return { ok: true, text, cancelled: signal.aborted, toolUses, stopReason }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuterAbort)
    }
  } catch (err) {
    if (signal.aborted) return { ok: true, text, cancelled: true, toolUses: [], stopReason }
    // BRAIN-3 / BUG-003: raw transport messages never cross to the renderer — they can
    // quote request detail. The stall gets its typed reason; everything else is opaque
    // (the raw error stays observable in MAIN's log only).
    console.error('[jarvis] stream transport error:', err)
    return {
      ok: false,
      reason: 'provider-error',
      message: stalled
        ? `anthropic: stream stalled (no data for ${Math.round((deps.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS) / 1000)}s)`
        : 'anthropic: transport error'
    }
  }
}

/** Mock helper: pull the last user message back out of the built request body — its text
 *  and any tool_result blocks (the J4 mock grounds its follow-up reply in them). */
function extractLastUserMessage(req: JarvisRequest): {
  text: string
  toolResults: Array<{ content: string; isError: boolean }>
} {
  try {
    const body = JSON.parse(req.body) as {
      messages?: Array<{ role: string; content: unknown }>
    }
    const users = (body.messages ?? []).filter((m) => m.role === 'user')
    const last = users.length > 0 ? users[users.length - 1] : undefined
    if (!last) return { text: '', toolResults: [] }
    if (typeof last.content === 'string') return { text: last.content, toolResults: [] }
    if (Array.isArray(last.content)) {
      const toolResults = (last.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
          isError: b.is_error === true
        }))
      const text = (last.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join(' ')
      return { text, toolResults }
    }
    return { text: '', toolResults: [] }
  } catch {
    return { text: '', toolResults: [] }
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

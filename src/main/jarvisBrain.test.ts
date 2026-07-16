import { describe, it, expect } from 'vitest'
import {
  buildJarvisRequest,
  createSseParser,
  mockJarvisReply,
  streamJarvisReply,
  type JarvisStreamDeps,
  type StreamFetchLike
} from './jarvisBrain'

const REQ = buildJarvisRequest(
  'claude-opus-4-8',
  'sk-test',
  [{ type: 'text', text: 'persona', cache_control: { type: 'ephemeral' } }],
  [{ role: 'user', content: 'hello' }]
)

function sse(...frames: string[]): string {
  return frames.map((f) => `data: ${f}\n\n`).join('')
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  for (const p of parts) yield enc.encode(p)
}

const depsWith = (fetchImpl: StreamFetchLike): JarvisStreamDeps => ({ fetch: fetchImpl, env: {} })

describe('buildJarvisRequest', () => {
  it('builds a streaming Messages-API request with the cached persona system block', () => {
    expect(REQ.url).toBe('https://api.anthropic.com/v1/messages')
    expect(REQ.headers['x-api-key']).toBe('sk-test')
    const body = JSON.parse(REQ.body) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.model).toBe('claude-opus-4-8')
    expect((body.system as { cache_control?: unknown }[])[0].cache_control).toEqual({
      type: 'ephemeral'
    })
  })
})

describe('createSseParser', () => {
  it('parses text deltas, message_stop, and skips noise frames', () => {
    const p = createSseParser()
    const events = p.push(
      sse(
        '{"type":"message_start"}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
        '{"type":"ping"}',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
        '{"type":"message_stop"}'
      )
    )
    expect(events).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'stop' }
    ])
  })

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const p = createSseParser()
    const whole = sse('{"type":"content_block_delta","delta":{"type":"text_delta","text":"split"}}')
    const cut = 17
    expect(p.push(whole.slice(0, cut))).toEqual([])
    expect(p.push(whole.slice(cut))).toEqual([{ kind: 'delta', text: 'split' }])
  })

  it('maps an error frame to an opaque error (type only, never the message body)', () => {
    const p = createSseParser()
    const events = p.push(
      sse('{"type":"error","error":{"type":"overloaded_error","message":"secret detail"}}')
    )
    expect(events).toEqual([{ kind: 'error', message: 'stream error: overloaded_error' }])
  })

  it('skips a garbled frame without throwing', () => {
    const p = createSseParser()
    expect(p.push('data: {oops\n\n')).toEqual([])
  })
})

describe('streamJarvisReply', () => {
  it('streams deltas and resolves the full text on message_stop', async () => {
    const payload = sse(
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Good "}}',
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"day."}}',
      '{"type":"message_stop"}'
    )
    const deps = depsWith(async () => ({ ok: true, status: 200, body: chunks(payload) }))
    const seen: string[] = []
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, (t) => seen.push(t))
    expect(r).toMatchObject({ ok: true, text: 'Good day.', cancelled: false, toolUses: [] })
    expect(seen).toEqual(['Good ', 'day.'])
  })

  it('maps a non-2xx to an opaque provider error (no body detail)', async () => {
    const deps = depsWith(async () => ({ ok: false, status: 401, body: null }))
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, () => {})
    expect(r).toEqual({ ok: false, reason: 'provider-error', message: 'anthropic HTTP 401' })
  })

  it('an abort mid-stream resolves as a CANCELLED success with the partial text', async () => {
    const abort = new AbortController()
    const deps = depsWith(async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        const enc = new TextEncoder()
        yield enc.encode(
          sse('{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}')
        )
        abort.abort() // the user barged in between chunks
        yield enc.encode(
          sse('{"type":"content_block_delta","delta":{"type":"text_delta","text":" never"}}')
        )
      })()
    }))
    const r = await streamJarvisReply(REQ, deps, abort.signal, () => {})
    expect(r).toMatchObject({ ok: true, text: 'partial', cancelled: true })
  })

  it('a MID-stream stall (silent, unclosed body) aborts via the re-armed watchdog', async () => {
    const deps: JarvisStreamDeps = {
      env: {},
      stallTimeoutMs: 50,
      fetch: async (_url, init) => ({
        ok: true,
        status: 200,
        body: (async function* () {
          const enc = new TextEncoder()
          yield enc.encode(
            sse('{"type":"content_block_delta","delta":{"type":"text_delta","text":"first"}}')
          )
          // Server goes silent WITHOUT closing: hang until the stall watchdog aborts.
          await new Promise<void>((resolve) => {
            init.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new DOMException('aborted', 'AbortError')
        })()
      })
    }
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, () => {})
    expect(r.ok).toBe(false) // watchdog abort, NOT a silent forever-hang
    if (!r.ok) expect(r.reason).toBe('provider-error')
  }, 5000)

  it('a thrown transport error surfaces as provider-error, not a rejection', async () => {
    const deps = depsWith(async () => {
      throw new Error('boom')
    })
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, () => {})
    expect(r).toEqual({ ok: false, reason: 'provider-error', message: 'boom' })
  })

  it('a PRE-aborted signal returns cancelled without fetching (BRAIN-1)', async () => {
    // The abort landed while the caller was still awaiting the manifest — a listener
    // attached now would never fire, and pre-fix the dead turn still issued the full
    // paid request concurrently with the superseding turn.
    let fetched = false
    const deps = depsWith(async () => {
      fetched = true
      return { ok: true, status: 200, body: null }
    })
    const abort = new AbortController()
    abort.abort()
    const r = await streamJarvisReply(REQ, deps, abort.signal, () => {})
    expect(r).toMatchObject({ ok: true, text: '', cancelled: true })
    expect(fetched).toBe(false)
  })

  it('a pre-aborted signal short-circuits the mock path too (no deltas)', async () => {
    const abort = new AbortController()
    abort.abort()
    const seen: string[] = []
    const r = await streamJarvisReply(
      REQ,
      { fetch: async () => ({ ok: true, status: 200, body: null }), env: { CANVAS_LLM_MOCK: '1' } },
      abort.signal,
      (t) => seen.push(t)
    )
    expect(r).toMatchObject({ ok: true, text: '', cancelled: true })
    expect(seen).toEqual([])
  })

  it('CANVAS_LLM_MOCK streams the deterministic reply with zero egress', async () => {
    let fetched = false
    const deps: JarvisStreamDeps = {
      fetch: async () => {
        fetched = true
        return { ok: true, status: 200, body: null }
      },
      env: { CANVAS_LLM_MOCK: '1' }
    }
    const seen: string[] = []
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, (t) => seen.push(t))
    expect(fetched).toBe(false)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe(mockJarvisReply('hello'))
    expect(seen.length).toBeGreaterThan(1) // streamed in pieces
  })
})

// ── J4 (hands): tool_use parsing, stream assembly, the mock tool script ──

describe('J4 tool_use parsing', () => {
  it('parses the tool block family + the message_delta stop_reason', () => {
    const p = createSseParser()
    const events = p.push(
      sse(
        '{"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_1","name":"add_card","input":{}}}',
        '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"board\\":"}}',
        '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"abc\\"}"}}',
        '{"type":"content_block_stop"}',
        '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
        '{"type":"message_stop"}'
      )
    )
    expect(events).toEqual([
      { kind: 'tool_start', id: 'tu_1', name: 'add_card' },
      { kind: 'tool_input', partial: '{"board":' },
      { kind: 'tool_input', partial: '"abc"}' },
      { kind: 'tool_stop' },
      { kind: 'stop_reason', reason: 'tool_use' },
      { kind: 'stop' }
    ])
  })

  it('assembles a complete tool call (text + tool_use) from the stream', async () => {
    const payload = sse(
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"On it."}}',
      '{"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_9","name":"focus_viewport","input":{}}}',
      '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"board\\":\\"abcdef12\\"}"}}',
      '{"type":"content_block_stop"}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '{"type":"message_stop"}'
    )
    const deps = depsWith(async () => ({ ok: true, status: 200, body: chunks(payload) }))
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, () => {})
    expect(r).toMatchObject({
      ok: true,
      text: 'On it.',
      stopReason: 'tool_use',
      toolUses: [{ id: 'tu_9', name: 'focus_viewport', input: { board: 'abcdef12' } }]
    })
  })

  it('a garbled tool input settles as {} instead of throwing', async () => {
    const payload = sse(
      '{"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_2","name":"add_card","input":{}}}',
      '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{oops"}}',
      '{"type":"content_block_stop"}',
      '{"type":"message_stop"}'
    )
    const deps = depsWith(async () => ({ ok: true, status: 200, body: chunks(payload) }))
    const r = await streamJarvisReply(REQ, deps, new AbortController().signal, () => {})
    expect(r).toMatchObject({ ok: true, toolUses: [{ id: 'tu_2', name: 'add_card', input: {} }] })
  })

  it('buildJarvisRequest passes tools through (and omits the key when absent)', () => {
    const withTools = buildJarvisRequest(
      'claude-opus-4-8',
      'k',
      [],
      [{ role: 'user', content: 'x' }],
      [{ name: 't', description: 'd', input_schema: { type: 'object' } }]
    )
    expect((JSON.parse(withTools.body) as { tools: unknown[] }).tools).toHaveLength(1)
    expect(JSON.parse(REQ.body)).not.toHaveProperty('tools')
  })
})

describe('J4 mock tool script (mockJarvisTurn via the mock stream)', () => {
  const mockDeps: JarvisStreamDeps = {
    fetch: async () => ({ ok: true, status: 200, body: null }),
    env: { CANVAS_LLM_MOCK: '1' }
  }

  it('"add a card … to board …" scripts an add_card tool call', async () => {
    const req = buildJarvisRequest(
      'm',
      'k',
      [],
      [{ role: 'user', content: 'add a card smoke test to board abcdef12' }]
    )
    const r = await streamJarvisReply(req, mockDeps, new AbortController().signal, () => {})
    expect(r).toMatchObject({
      ok: true,
      stopReason: 'tool_use',
      toolUses: [{ name: 'add_card', input: { board: 'abcdef12', title: 'smoke test' } }]
    })
  })

  it('a tool_result hop answers GROUNDED in the result content', async () => {
    const req = buildJarvisRequest(
      'm',
      'k',
      [],
      [
        { role: 'user', content: 'add a card x to board y' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'add_card', input: {} }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"cardId":"c-77"}' }]
        }
      ]
    )
    const r = await streamJarvisReply(req, mockDeps, new AbortController().signal, () => {})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('c-77') // quoted FROM the tool result, not invented
      expect(r.stopReason).toBe('end_turn')
    }
  })

  it('a denied/error tool_result hop says nothing changed', async () => {
    const req = buildJarvisRequest(
      'm',
      'k',
      [],
      [
        { role: 'user', content: 'add a card x to board y' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'add_card', input: {} }]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'the user declined', is_error: true }
          ]
        }
      ]
    )
    const r = await streamJarvisReply(req, mockDeps, new AbortController().signal, () => {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('Nothing was changed')
  })
})

/**
 * jarvisBrainOpenAi — the chat/completions converters + SSE parser (shared Context·LLM
 * rewire). The parser must emit jarvisBrain's SseEvent union with the ANTHROPIC stop_reason
 * vocabulary so the stream consumer never branches on shape.
 */
import { describe, it, expect } from 'vitest'
import { createOpenAiSseParser, toOpenAiMessages, toOpenAiTools } from './jarvisBrainOpenAi'

const sse = (...frames: string[]): string => frames.map((f) => `data: ${f}\n\n`).join('')

describe('toOpenAiMessages', () => {
  it('folds the system blocks into one leading system message', () => {
    const out = toOpenAiMessages(
      [
        { type: 'text', text: 'persona', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Workspace:\n[abc] Terminal' }
      ],
      [{ role: 'user', content: 'hi' }]
    )
    expect(out[0]).toEqual({ role: 'system', content: 'persona\n\nWorkspace:\n[abc] Terminal' })
    expect(out[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('maps an assistant tool_use hop and its tool_result blocks to tool_calls + role:tool', () => {
    const out = toOpenAiMessages(
      [],
      [
        { role: 'user', content: 'add a card' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'One card coming up.' },
            { type: 'tool_use', id: 'call_1', name: 'add_card', input: { board: 'abc' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"cardId":"c-7"}' }]
        }
      ]
    )
    expect(out).toEqual([
      { role: 'user', content: 'add a card' },
      {
        role: 'assistant',
        content: 'One card coming up.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'add_card', arguments: '{"board":"abc"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"cardId":"c-7"}' }
    ])
  })

  it('a tool-only assistant hop carries content:null; an error result is prefixed', () => {
    const out = toOpenAiMessages(
      [],
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'add_card', input: {} }]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'the user declined', is_error: true }
          ]
        }
      ]
    )
    expect(out[0]).toMatchObject({ role: 'assistant', content: null })
    expect(out[1]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'ERROR: the user declined'
    })
  })
})

describe('toOpenAiTools', () => {
  it('wraps the JSON-Schema defs in the function envelope', () => {
    expect(
      toOpenAiTools([{ name: 't', description: 'd', input_schema: { type: 'object' } }])
    ).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } }
      }
    ])
  })
})

describe('createOpenAiSseParser', () => {
  it('parses content deltas and maps finish_reason stop → end_turn, then [DONE] → stop', () => {
    const p = createOpenAiSseParser()
    const events = p.push(
      sse(
        '{"choices":[{"delta":{"content":"Hel"}}]}',
        '{"choices":[{"delta":{"content":"lo"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]'
      )
    )
    expect(events).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'stop_reason', reason: 'end_turn' },
      { kind: 'stop' }
    ])
  })

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const p = createOpenAiSseParser()
    const whole = sse('{"choices":[{"delta":{"content":"split"}}]}')
    expect(p.push(whole.slice(0, 19))).toEqual([])
    expect(p.push(whole.slice(19))).toEqual([{ kind: 'delta', text: 'split' }])
  })

  it('assembles a streamed tool call: id+name frame opens, argument fragments follow', () => {
    const p = createOpenAiSseParser()
    const events = p.push(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"focus_viewport","arguments":""}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"board\\":"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"abc\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
      )
    )
    expect(events).toEqual([
      { kind: 'tool_start', id: 'call_9', name: 'focus_viewport' },
      { kind: 'tool_input', partial: '{"board":' },
      { kind: 'tool_input', partial: '"abc"}' },
      { kind: 'tool_stop' },
      { kind: 'stop_reason', reason: 'tool_use' } // NORMALIZED to the Anthropic vocabulary
    ])
  })

  it('a second tool index closes the first call before opening the next', () => {
    const p = createOpenAiSseParser()
    const events = p.push(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"t1","arguments":"{}"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"t2","arguments":"{}"}}]}}]}'
      )
    )
    expect(events.map((e) => e.kind)).toEqual([
      'tool_start',
      'tool_input',
      'tool_stop',
      'tool_start',
      'tool_input'
    ])
  })

  it('maps an error frame to an opaque error (type/code only, never the message)', () => {
    const p = createOpenAiSseParser()
    expect(
      p.push(sse('{"error":{"code":402,"message":"secret request detail","type":null}}'))
    ).toEqual([{ kind: 'error', message: 'stream error: 402' }])
  })

  it('skips garbled frames and non-data lines (SSE comments) without throwing', () => {
    const p = createOpenAiSseParser()
    expect(p.push(': OPENROUTER PROCESSING\n\ndata: {oops\n\n')).toEqual([])
  })
})

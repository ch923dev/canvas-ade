import { describe, it, expect } from 'vitest'
import { buildRequest, parseResponse, type SummarizeInput } from './llmService'

const input: SummarizeInput = { system: 'be terse', text: 'hello world' }

describe('buildRequest', () => {
  it('builds an OpenAI-shape chat request for openrouter', () => {
    const r = buildRequest('openrouter', { provider: 'openrouter', model: 'm1' }, 'KEY', input)
    expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(r.headers.Authorization).toBe('Bearer KEY')
    const body = JSON.parse(r.body) as { model: string; messages: { role: string; content: string }[] }
    expect(body.model).toBe('m1')
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello world' }
    ])
  })

  it('builds an OpenAI request for openai', () => {
    const r = buildRequest('openai', { provider: 'openai', model: 'gpt-4o-mini' }, 'K', input)
    expect(r.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(r.headers.Authorization).toBe('Bearer K')
  })

  it('builds an Anthropic messages request with version + x-api-key', () => {
    const r = buildRequest('anthropic', { provider: 'anthropic', model: 'claude' }, 'AK', input)
    expect(r.url).toBe('https://api.anthropic.com/v1/messages')
    expect(r.headers['x-api-key']).toBe('AK')
    expect(r.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(r.body) as { model: string; system?: string; max_tokens: number; messages: unknown[] }
    expect(body.model).toBe('claude')
    expect(body.system).toBe('be terse')
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.messages).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('uses the config baseUrl for the local provider', () => {
    const r = buildRequest(
      'local',
      { provider: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' },
      '',
      input
    )
    expect(r.url).toBe('http://127.0.0.1:1234/v1/chat/completions')
  })

  it('omits the system message when none is given', () => {
    const r = buildRequest('openai', { provider: 'openai', model: 'm' }, 'K', { text: 'hi' })
    const body = JSON.parse(r.body) as { messages: { role: string }[] }
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('parseResponse', () => {
  it('extracts OpenAI/openrouter chat content', () => {
    const json = { choices: [{ message: { content: 'summary text' } }] }
    expect(parseResponse('openrouter', json)).toBe('summary text')
  })

  it('extracts Anthropic content text', () => {
    const json = { content: [{ type: 'text', text: 'anthropic summary' }] }
    expect(parseResponse('anthropic', json)).toBe('anthropic summary')
  })

  it('throws on a malformed response', () => {
    expect(() => parseResponse('openai', {})).toThrow()
    expect(() => parseResponse('anthropic', { content: [] })).toThrow()
  })
})

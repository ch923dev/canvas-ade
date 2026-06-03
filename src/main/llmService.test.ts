import { describe, it, expect } from 'vitest'
import { buildRequest, parseResponse, getProvider, isMockEnabled, keyForProvider, runSummarize, type SummarizeInput, type SummarizeResult, type ProviderDeps, type FetchLike } from './llmService'

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

  it('throws when the local provider has no baseUrl', () => {
    expect(() =>
      buildRequest('local', { provider: 'local', model: 'm' }, '', { text: 'hi' })
    ).toThrow(/baseUrl/)
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

const fakeFetch = (): never => {
  throw new Error('network must not be called in this test')
}
const deps = (env: Record<string, string | undefined>): ProviderDeps => ({ fetch: fakeFetch as never, env })

describe('keyForProvider', () => {
  it('reads the per-provider env var', () => {
    expect(keyForProvider('openrouter', { OPENROUTER_API_KEY: 'a' })).toBe('a')
    expect(keyForProvider('openai', { OPENAI_API_KEY: 'b' })).toBe('b')
    expect(keyForProvider('anthropic', { ANTHROPIC_API_KEY: 'c' })).toBe('c')
  })
  it('returns undefined when the env var is absent', () => {
    expect(keyForProvider('openrouter', {})).toBeUndefined()
  })
})

describe('isMockEnabled', () => {
  it('is on under CANVAS_LLM_MOCK=1 or CANVAS_SMOKE=e2e', () => {
    expect(isMockEnabled({ CANVAS_LLM_MOCK: '1' })).toBe(true)
    expect(isMockEnabled({ CANVAS_SMOKE: 'e2e' })).toBe(true)
    expect(isMockEnabled({})).toBe(false)
  })
})

describe('getProvider', () => {
  it('returns null when no key is configured (no-provider)', () => {
    expect(getProvider({ provider: 'openrouter', model: 'm' }, deps({}))).toBeNull()
  })
  it('returns a provider when the key env var is present', () => {
    const p = getProvider({ provider: 'openrouter', model: 'm' }, deps({ OPENROUTER_API_KEY: 'k' }))
    expect(p).not.toBeNull()
  })
  it('returns a mock provider that resolves a stub without network when mock is enabled', async () => {
    const p = getProvider({ provider: 'openrouter', model: 'm' }, deps({ CANVAS_LLM_MOCK: '1' }))
    expect(p).not.toBeNull()
    await expect(p!.summarize({ text: 'ping' })).resolves.toBe('[mock] ping')
  })
  it('allows the local provider with no key', () => {
    const p = getProvider(
      { provider: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' },
      deps({})
    )
    expect(p).not.toBeNull()
  })
  it('mock wins even when a real API key is present in env', async () => {
    const p = getProvider(
      { provider: 'openrouter', model: 'm' },
      deps({ CANVAS_LLM_MOCK: '1', OPENROUTER_API_KEY: 'should-not-be-used' })
    )
    expect(p).not.toBeNull()
    await expect(p!.summarize({ text: 'ping' })).resolves.toBe('[mock] ping')
  })
})

const okFetch =
  (payload: unknown): FetchLike =>
  () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve('')
    })

const errFetch: FetchLike = () =>
  Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('boom')
  })

describe('runSummarize', () => {
  it('returns ok + text on a successful call', async () => {
    const r = await runSummarize(
      { provider: 'openrouter', model: 'm' },
      { text: 'hi' },
      { fetch: okFetch({ choices: [{ message: { content: 'done' } }] }), env: { OPENROUTER_API_KEY: 'k' } }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: 'done' })
  })

  it('returns no-provider when there is no key', async () => {
    const r = await runSummarize(
      { provider: 'openrouter', model: 'm' },
      { text: 'hi' },
      { fetch: errFetch, env: {} }
    )
    expect(r).toEqual<SummarizeResult>({ ok: false, reason: 'no-provider' })
  })

  it('returns provider-error when the call fails', async () => {
    const r = await runSummarize(
      { provider: 'openrouter', model: 'm' },
      { text: 'hi' },
      { fetch: errFetch, env: { OPENROUTER_API_KEY: 'k' } }
    )
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'provider-error' })
  })

  it('returns the mock stub under e2e with no network', async () => {
    const r = await runSummarize(
      { provider: 'openrouter', model: 'm' },
      { text: 'ping' },
      { fetch: errFetch, env: { CANVAS_SMOKE: 'e2e' } }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: '[mock] ping' })
  })
})

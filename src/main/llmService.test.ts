import { describe, it, expect } from 'vitest'
import {
  buildRequest,
  parseResponse,
  getProvider,
  isMockEnabled,
  keyForProvider,
  runSummarize,
  isForeignSender,
  registerLlmHandlers,
  type SummarizeInput,
  type SummarizeResult,
  type ProviderDeps,
  type FetchLike,
  type LlmStatus
} from './llmService'

const input: SummarizeInput = { system: 'be terse', text: 'hello world' }

describe('buildRequest', () => {
  it('builds an OpenAI-shape chat request for openrouter', () => {
    const r = buildRequest('openrouter', { provider: 'openrouter', model: 'm1' }, 'KEY', input)
    expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(r.headers.Authorization).toBe('Bearer KEY')
    const body = JSON.parse(r.body) as {
      model: string
      messages: { role: string; content: string }[]
    }
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
    const body = JSON.parse(r.body) as {
      model: string
      system?: string
      max_tokens: number
      messages: unknown[]
    }
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
const deps = (env: Record<string, string | undefined>): ProviderDeps => ({
  fetch: fakeFetch as never,
  env
})

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
      {
        fetch: okFetch({ choices: [{ message: { content: 'done' } }] }),
        env: { OPENROUTER_API_KEY: 'k' }
      }
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
    expect(r).toMatchObject({ reason: 'provider-error', message: expect.any(String) })
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

describe('isForeignSender', () => {
  const frame = {} as never
  it('allows a synthetic call (no senderFrame)', () => {
    expect(isForeignSender({ senderFrame: null } as never, () => frame)).toBe(false)
  })
  it('denies a real sender when the window is unresolved', () => {
    expect(isForeignSender({ senderFrame: frame } as never, () => null)).toBe(true)
  })
  it('allows the main frame and denies a different frame', () => {
    expect(isForeignSender({ senderFrame: frame } as never, () => frame)).toBe(false)
    expect(isForeignSender({ senderFrame: {} as never } as never, () => frame)).toBe(true)
  })
})

describe('registerLlmHandlers', () => {
  function fakeIpc(): {
    ipcMain: { handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void }
    call: (c: string, a?: unknown) => Promise<unknown>
  } {
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    return {
      ipcMain: { handle: (c, h) => void handlers.set(c, h) },
      call: (c, a) => Promise.resolve(handlers.get(c)!({ senderFrame: null }, a))
    }
  }

  it('summarize round-trips through the handler (mock env, no network)', async () => {
    const f = fakeIpc()
    registerLlmHandlers(f.ipcMain as never, () => null, '/no/such/dir', {
      fetch: (() => {
        throw new Error('no network')
      }) as never,
      env: { CANVAS_LLM_MOCK: '1' }
    })
    const r = await f.call('llm:summarize', { text: 'ping' })
    expect(r).toEqual({ ok: true, text: '[mock] ping' })
  })

  it('status reports a provider + model and never leaks key material', async () => {
    const f = fakeIpc()
    registerLlmHandlers(f.ipcMain as never, () => null, '/no/such/dir', {
      fetch: (() => {
        throw new Error('no network')
      }) as never,
      env: { OPENROUTER_API_KEY: 'secret-key' }
    })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.hasProvider).toBe(true)
    expect(s.provider).toBe('openrouter')
    expect(JSON.stringify(s)).not.toContain('secret-key')
  })

  it('summarize rejects a foreign sender (guard chain through the handler)', async () => {
    const mainFrame = {}
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    registerLlmHandlers(
      {
        handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
      } as never,
      () => ({ webContents: { mainFrame } }) as never,
      '/no/such/dir',
      {
        fetch: (() => {
          throw new Error('no network')
        }) as never,
        env: { CANVAS_LLM_MOCK: '1' }
      }
    )
    const r = await Promise.resolve(
      handlers.get('llm:summarize')!({ senderFrame: {} }, { text: 'x' })
    )
    expect(r).toEqual({ ok: false, reason: 'provider-error', message: 'forbidden sender' })
  })

  it('status returns the degraded shape for a foreign sender', async () => {
    const mainFrame = {}
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    registerLlmHandlers(
      {
        handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
      } as never,
      () => ({ webContents: { mainFrame } }) as never,
      '/no/such/dir',
      {
        fetch: (() => {
          throw new Error('no network')
        }) as never,
        env: { OPENROUTER_API_KEY: 'secret-key' }
      }
    )
    const s = (await Promise.resolve(
      handlers.get('llm:status')!({ senderFrame: {} }, undefined)
    )) as LlmStatus
    expect(s.hasProvider).toBe(false)
    expect(JSON.stringify(s)).not.toContain('secret-key')
  })
})

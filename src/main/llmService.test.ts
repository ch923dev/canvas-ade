import { describe, it, expect, vi } from 'vitest'
import {
  buildRequest,
  parseResponse,
  getProvider,
  isMockEnabled,
  keyForProvider,
  runSummarize,
  type SummarizeInput,
  type SummarizeResult,
  type ProviderDeps,
  type FetchLike
} from './llmService'
import { DEFAULT_MAX_CALLS_PER_DAY } from './llmBudget'
import type { KeyStore } from './llmKeyStore'

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
  it('is on under CANVAS_LLM_MOCK=1 only (the deleted CANVAS_SMOKE harness no longer applies)', () => {
    expect(isMockEnabled({ CANVAS_LLM_MOCK: '1' })).toBe(true)
    expect(isMockEnabled({ CANVAS_SMOKE: 'e2e' })).toBe(false)
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
      { fetch: errFetch, env: { CANVAS_LLM_MOCK: '1' } }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: '[mock] ping' })
  })

  // --- T-B3: budget reservation -------------------------------------------------
  // A fetch that records calls and returns a successful real-egress payload.
  const okBudgetFetch = (): FetchLike =>
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: 'real' } }] }),
        text: () => Promise.resolve('')
      })
    )

  // A budget whose tryConsume is scripted; counts how many times it was consulted.
  function budgetReturning(allowed: boolean): {
    store: import('./llmBudget').BudgetStore
    calls: () => number
    lastCap: () => number | undefined
  } {
    let n = 0
    let lastCap: number | undefined
    return {
      store: {
        tryConsume: (cap) => {
          n++
          lastCap = cap
          return allowed
        },
        peek: () => ({ day: '2026-06-03', calls: n })
      },
      calls: () => n,
      lastCap: () => lastCap
    }
  }

  const budgetCfg = { provider: 'openrouter' as const, model: 'm' }

  it('real egress consults the budget and returns ok when allowed', async () => {
    const fetch = okBudgetFetch()
    const b = budgetReturning(true)
    const r = await runSummarize(
      budgetCfg,
      { text: 'hi' },
      { fetch, env: { OPENROUTER_API_KEY: 'k' }, budget: b.store }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: 'real' })
    expect(b.calls()).toBe(1)
    expect(b.lastCap()).toBe(DEFAULT_MAX_CALLS_PER_DAY) // no config cap → the default is passed
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('passes the configured cap through to the budget (config wins over the default)', async () => {
    const fetch = okBudgetFetch()
    const b = budgetReturning(true)
    const r = await runSummarize(
      { ...budgetCfg, maxCallsPerDay: 7 },
      { text: 'hi' },
      { fetch, env: { OPENROUTER_API_KEY: 'k' }, budget: b.store }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: 'real' })
    expect(b.lastCap()).toBe(7)
  })

  it('returns budget-exceeded WITHOUT calling fetch when the cap is hit', async () => {
    const fetch = okBudgetFetch()
    const b = budgetReturning(false)
    const r = await runSummarize(
      budgetCfg,
      { text: 'hi' },
      { fetch, env: { OPENROUTER_API_KEY: 'k' }, budget: b.store }
    )
    expect(r).toEqual<SummarizeResult>({ ok: false, reason: 'budget-exceeded' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does NOT consult the budget under the mock seam with no explicit cap', async () => {
    const b = budgetReturning(false) // would block if consulted
    const r = await runSummarize(
      budgetCfg,
      { text: 'hi' },
      { fetch: vi.fn() as never, env: { CANVAS_LLM_MOCK: '1' }, budget: b.store }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: '[mock] hi' })
    expect(b.calls()).toBe(0) // budget untouched
  })

  it('DOES enforce under the mock seam when an explicit cap is configured', async () => {
    const b = budgetReturning(false)
    const r = await runSummarize(
      { ...budgetCfg, maxCallsPerDay: 1 },
      { text: 'hi' },
      { fetch: vi.fn() as never, env: { CANVAS_LLM_MOCK: '1' }, budget: b.store }
    )
    expect(r).toEqual<SummarizeResult>({ ok: false, reason: 'budget-exceeded' })
  })

  it('skips enforcement entirely when no budget is injected (back-compat)', async () => {
    const r = await runSummarize(
      budgetCfg,
      { text: 'hi' },
      { fetch: okBudgetFetch(), env: { OPENROUTER_API_KEY: 'k' } }
    )
    expect(r).toEqual<SummarizeResult>({ ok: true, text: 'real' })
  })
})

describe('llmService — fetch timeout (T-M3)', () => {
  it('aborts a hung provider and degrades to provider-error', async () => {
    // A fetch that never resolves on its own — it only settles when the injected
    // AbortController fires signal.abort, rejecting like the real fetch does.
    const hung: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    const config = { provider: 'openrouter' as const, model: 'm' }
    const res = await runSummarize(
      config,
      { text: 'hello' },
      { fetch: hung, env: { OPENROUTER_API_KEY: 'k' }, timeoutMs: 10 }
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('provider-error')
  })
})

// A getKey-only fake store for resolution tests.
const fakeStore = (keys: Partial<Record<string, string>>): Pick<KeyStore, 'getKey'> => ({
  getKey: (p) => keys[p]
})

describe('keyForProvider precedence (store-first, env fallback)', () => {
  it('prefers the key store over the env var', () => {
    expect(
      keyForProvider(
        'openrouter',
        { OPENROUTER_API_KEY: 'from-env' },
        fakeStore({ openrouter: 'from-store' })
      )
    ).toBe('from-store')
  })
  it('falls back to the env var when the store has no key', () => {
    expect(keyForProvider('openrouter', { OPENROUTER_API_KEY: 'from-env' }, fakeStore({}))).toBe(
      'from-env'
    )
  })
  it('returns undefined when neither store nor env has a key', () => {
    expect(keyForProvider('openrouter', {}, fakeStore({}))).toBeUndefined()
  })
  it('works with no store (env only) — T-B1 behaviour preserved', () => {
    expect(keyForProvider('openrouter', { OPENROUTER_API_KEY: 'k' })).toBe('k')
  })
  it('getProvider resolves a provider from the store alone (no env)', () => {
    const p = getProvider(
      { provider: 'openrouter', model: 'm' },
      { fetch: errFetch, env: {}, keyStore: fakeStore({ openrouter: 'sk' }) }
    )
    expect(p).not.toBeNull()
  })
})

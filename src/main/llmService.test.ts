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
import type { KeyStore } from './llmKeyStore'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Encryptor } from './llmKeyStore'

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

const fakeEncryptor = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
  decryptString: (e) => e.toString('utf8').replace(/^ENC:/, '')
})

function setupKeyed(encryptor: Encryptor) {
  const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
  const dir = mkdtempSync(join(tmpdir(), 'llm-ipc-'))
  registerLlmHandlers(
    {
      handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
    } as never,
    () => null,
    dir,
    undefined,
    encryptor
  )
  return {
    dir,
    call: (c: string, a?: unknown) => Promise.resolve(handlers.get(c)!({ senderFrame: null }, a)),
    callForeign: (c: string, a?: unknown) =>
      Promise.resolve(handlers.get(c)!({ senderFrame: {} }, a))
  }
}

describe('registerLlmHandlers — key channels', () => {
  it('setKey persists and status reports hasKey:true (key never returned)', async () => {
    const f = setupKeyed(fakeEncryptor())
    const set = (await f.call('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })) as {
      ok: boolean
    }
    expect(set.ok).toBe(true)
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.hasKey).toBe(true)
    expect(Object.values(s)).not.toContain('sk-xyz')
  })

  it('clearKey removes the key (hasKey:false after)', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })
    const cleared = (await f.call('llm:clearKey', { provider: 'openrouter' })) as { ok: boolean }
    expect(cleared.ok).toBe(true)
    expect(((await f.call('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setKey refuses cleanly when encryption is unavailable', async () => {
    const f = setupKeyed(fakeEncryptor(false))
    const set = (await f.call('llm:setKey', { provider: 'openrouter', key: 'x' })) as {
      ok: boolean
      reason?: string
    }
    expect(set).toEqual({ ok: false, reason: 'encryption-unavailable' })
    expect(((await f.call('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setConfig persists provider/model and status reflects it', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setConfig', { provider: 'anthropic', model: 'claude-3-5-haiku-latest' })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.provider).toBe('anthropic')
    expect(s.model).toBe('claude-3-5-haiku-latest')
  })

  it('status echoes the configured baseUrl for the local provider', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setConfig', {
      provider: 'local',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:1234/v1'
    })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.baseUrl).toBe('http://127.0.0.1:1234/v1')
  })

  it('all new channels reject a foreign sender', async () => {
    const f = setupKeyed(fakeEncryptor())
    expect(await f.callForeign('llm:setKey', { provider: 'openrouter', key: 'x' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await f.callForeign('llm:clearKey', { provider: 'openrouter' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await f.callForeign('llm:setConfig', { provider: 'openai', model: 'm' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listModels,
  CACHE_TTL_MS,
  type ModelsCatalogDeps,
  type FetchLike,
  type LlmModelEntry
} from './llmModelsCatalog'
import { writeLlmConfig, DEFAULT_MODELS } from './llmConfig'

const T0 = 1_752_700_000_000 // fixed epoch so TTL math is deterministic

/** A FetchLike that returns `json` with 200, recording calls. */
function okFetch(json: unknown): {
  fetch: FetchLike
  calls: { url: string; headers: Record<string, string> }[]
} {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) })
  }
  return { fetch, calls }
}

const failFetch: FetchLike = () => Promise.reject(new Error('network down'))

const neverFetch: FetchLike = () => {
  throw new Error('network must not be called in this test')
}

function deps(fetch: FetchLike, over?: Partial<ModelsCatalogDeps>): ModelsCatalogDeps {
  return { fetch, env: {}, clock: () => new Date(T0), ...over }
}

const OPENROUTER_JSON = {
  data: [
    {
      id: 'google/gemini-2.5-flash',
      name: 'Google: Gemini 2.5 Flash',
      context_length: 1_048_576,
      supported_parameters: ['tools', 'temperature'],
      // USD per TOKEN → ×1e6 → $0.3/M in, $2.5/M out.
      pricing: { prompt: '0.0000003', completion: '0.0000025' }
    },
    {
      id: 'meta-llama/llama-3-8b',
      name: 'Meta: Llama 3 8B',
      context_length: 8192,
      supported_parameters: ['temperature'],
      // A free model — both zero → { inputPerM: 0, outputPerM: 0 } (kept, not dropped).
      pricing: { prompt: '0', completion: '0' }
    }
  ]
}

describe('llmModelsCatalog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmmodels-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('provider fetch + parse', () => {
    it('openrouter: keyless fetch, normalizes id/label/context/toolUse', async () => {
      const { fetch, calls } = okFetch(OPENROUTER_JSON)
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models')
      expect(calls[0].headers).toEqual({})
      expect(r).toEqual({
        ok: true,
        fetchedAt: T0,
        models: [
          {
            id: 'google/gemini-2.5-flash',
            label: 'Google: Gemini 2.5 Flash',
            contextLength: 1_048_576,
            toolUse: true,
            pricing: { inputPerM: 0.3, outputPerM: 2.5 }
          },
          {
            id: 'meta-llama/llama-3-8b',
            label: 'Meta: Llama 3 8B',
            contextLength: 8192,
            toolUse: false,
            pricing: { inputPerM: 0, outputPerM: 0 }
          }
        ]
      })
    })

    it('openrouter: drops malformed/absent pricing but keeps the entry', async () => {
      const { fetch } = okFetch({
        data: [
          { id: 'bad/price', pricing: { prompt: 'n/a', completion: '0.000001' } }, // unparseable in
          { id: 'neg/price', pricing: { prompt: '-0.01', completion: '0.01' } }, // negative → drop
          { id: 'no/price' } // no pricing field at all
        ]
      })
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(r).toEqual({
        ok: true,
        fetchedAt: T0,
        models: [{ id: 'bad/price' }, { id: 'neg/price' }, { id: 'no/price' }]
      })
    })

    it('openai: Bearer auth, filters non-chat families, toolUse unknown', async () => {
      const { fetch, calls } = okFetch({
        data: [
          { id: 'gpt-4.1-nano' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'tts-1-hd' },
          { id: 'dall-e-3' },
          { id: 'gpt-4o-audio-preview' }
        ]
      })
      const r = await listModels(
        dir,
        'openai',
        false,
        deps(fetch, { env: { OPENAI_API_KEY: 'K' } })
      )
      expect(calls[0].url).toBe('https://api.openai.com/v1/models')
      expect(calls[0].headers.Authorization).toBe('Bearer K')
      expect(r).toEqual({ ok: true, fetchedAt: T0, models: [{ id: 'gpt-4.1-nano' }] })
    })

    it('anthropic: x-api-key + version headers, display_name → label, toolUse true', async () => {
      const { fetch, calls } = okFetch({
        data: [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }]
      })
      const r = await listModels(
        dir,
        'anthropic',
        false,
        deps(fetch, { env: { ANTHROPIC_API_KEY: 'AK' } })
      )
      expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000')
      expect(calls[0].headers['x-api-key']).toBe('AK')
      expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
      expect(r).toEqual({
        ok: true,
        fetchedAt: T0,
        models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', toolUse: true }]
      })
    })

    it('local: lists {baseUrl}/models keyless, normalizing trailing slashes (BUG-041)', async () => {
      writeLlmConfig(dir, { provider: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1/' })
      const { fetch, calls } = okFetch({ data: [{ id: 'qwen2.5-7b-instruct' }] })
      const r = await listModels(dir, 'local', false, deps(fetch))
      expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/models')
      expect(calls[0].headers).toEqual({})
      expect(r).toEqual({ ok: true, fetchedAt: T0, models: [{ id: 'qwen2.5-7b-instruct' }] })
    })
  })

  describe('typed refusals', () => {
    it('openai / anthropic without a key → no-key, no fetch', async () => {
      for (const p of ['openai', 'anthropic'] as const) {
        const r = await listModels(dir, p, false, deps(neverFetch))
        expect(r).toEqual({ ok: false, reason: 'no-key' })
      }
    })

    it('local without a baseUrl → no-base-url, no fetch', async () => {
      const r = await listModels(dir, 'local', false, deps(neverFetch))
      expect(r).toEqual({ ok: false, reason: 'no-base-url' })
    })

    // BUG-001 (SSRF): a poisoned config on disk must never reach the egress fetch. readLlmConfig
    // already drops a non-loopback baseUrl on read; this asserts the catalog path end-to-end.
    it('local with a non-loopback baseUrl on disk → no-base-url, no egress (BUG-001)', async () => {
      writeFileSync(
        join(dir, 'llm-config.json'),
        JSON.stringify({
          provider: 'local',
          model: 'm',
          baseUrl: 'http://169.254.169.254/latest/'
        })
      )
      const r = await listModels(dir, 'local', false, deps(neverFetch))
      expect(r).toEqual({ ok: false, reason: 'no-base-url' })
    })

    it('HTTP error → provider-error with no body echoed (BUG-003)', async () => {
      const fetch: FetchLike = () =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: 'secret-leaking body' })
        })
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(r).toEqual({ ok: false, reason: 'provider-error' })
    })

    it('malformed response body → provider-error', async () => {
      const { fetch } = okFetch({ nope: true })
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(r).toEqual({ ok: false, reason: 'provider-error' })
    })
  })

  describe('cache', () => {
    it('serves a fresh cache without fetching; refresh bypasses it', async () => {
      const { fetch } = okFetch(OPENROUTER_JSON)
      await listModels(dir, 'openrouter', false, deps(fetch))
      expect(existsSync(join(dir, 'llm-models-cache.json'))).toBe(true)

      // Within TTL → cache hit, network untouched.
      const later = T0 + CACHE_TTL_MS - 1
      const hit = await listModels(
        dir,
        'openrouter',
        false,
        deps(neverFetch, { clock: () => new Date(later) })
      )
      expect(hit.ok && hit.fetchedAt).toBe(T0)
      expect(hit.ok && !hit.stale).toBe(true)

      // refresh:true → refetch even inside TTL.
      const { fetch: fetch2, calls } = okFetch(OPENROUTER_JSON)
      const fresh = await listModels(
        dir,
        'openrouter',
        true,
        deps(fetch2, { clock: () => new Date(later) })
      )
      expect(calls.length).toBe(1)
      expect(fresh.ok && fresh.fetchedAt).toBe(later)
    })

    it('expired cache refetches; fetch failure falls back to the stale entry', async () => {
      const { fetch } = okFetch(OPENROUTER_JSON)
      await listModels(dir, 'openrouter', false, deps(fetch))

      const expired = T0 + CACHE_TTL_MS + 1
      const r = await listModels(
        dir,
        'openrouter',
        false,
        deps(failFetch, { clock: () => new Date(expired) })
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.stale).toBe(true)
        expect(r.fetchedAt).toBe(T0)
        expect(r.models[0].id).toBe('google/gemini-2.5-flash')
      }
    })

    it('fetch failure with no cache → provider-error', async () => {
      const r = await listModels(dir, 'openrouter', false, deps(failFetch))
      expect(r).toEqual({ ok: false, reason: 'provider-error' })
    })

    it('local provider is never cached', async () => {
      writeLlmConfig(dir, { provider: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' })
      const { fetch } = okFetch({ data: [{ id: 'a' }] })
      await listModels(dir, 'local', false, deps(fetch))
      expect(existsSync(join(dir, 'llm-models-cache.json'))).toBe(false)
      // And a local fetch failure has no stale fallback.
      const r = await listModels(dir, 'local', false, deps(failFetch))
      expect(r).toEqual({ ok: false, reason: 'provider-error' })
    })

    it('cache entries are per-provider in one file', async () => {
      const { fetch } = okFetch(OPENROUTER_JSON)
      await listModels(dir, 'openrouter', false, deps(fetch))
      const { fetch: f2 } = okFetch({ data: [{ id: 'gpt-4.1-nano' }] })
      await listModels(dir, 'openai', false, deps(f2, { env: { OPENAI_API_KEY: 'K' } }))
      const all = JSON.parse(readFileSync(join(dir, 'llm-models-cache.json'), 'utf8')) as Record<
        string,
        { models: LlmModelEntry[] }
      >
      expect(all.openrouter.models).toHaveLength(2)
      // pricing survives the write→read cache round-trip (sanitizeEntries keeps it on read-back).
      expect(all.openrouter.models[0].pricing).toEqual({ inputPerM: 0.3, outputPerM: 2.5 })
      expect(all.openai.models).toEqual([{ id: 'gpt-4.1-nano' }])
    })

    it('a corrupt cache file is ignored (refetch) and repaired on the next write', async () => {
      writeFileSync(join(dir, 'llm-models-cache.json'), '{not json')
      const { fetch } = okFetch(OPENROUTER_JSON)
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(r.ok).toBe(true)
      const all = JSON.parse(readFileSync(join(dir, 'llm-models-cache.json'), 'utf8'))
      expect(all.openrouter.fetchedAt).toBe(T0)
    })
  })

  describe('bounds', () => {
    it('truncates oversized lists and skips oversized/malformed ids', async () => {
      const data = Array.from({ length: 2500 }, (_, i) => ({ id: `m-${i}` })) as {
        id: unknown
      }[]
      data[0] = { id: 'x'.repeat(300) } // oversized id → skipped
      data[1] = { id: 42 } // non-string id → skipped
      data[2] = { id: '' } // empty id → skipped
      const { fetch } = okFetch({ data })
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.models.length).toBe(2000)
        expect(r.models[0].id).toBe('m-3')
      }
    })

    it('drops malformed label/contextLength but keeps the entry', async () => {
      const { fetch } = okFetch({
        data: [{ id: 'ok', name: 'x'.repeat(300), context_length: -5, supported_parameters: 'no' }]
      })
      const r = await listModels(dir, 'openrouter', false, deps(fetch))
      expect(r).toEqual({ ok: true, fetchedAt: T0, models: [{ id: 'ok' }] })
    })

    it('passes an abort signal so a hung endpoint times out', async () => {
      let sawSignal = false
      const fetch: FetchLike = (_url, init) => {
        sawSignal = init.signal instanceof AbortSignal
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) })
      }
      await listModels(dir, 'openrouter', false, deps(fetch))
      expect(sawSignal).toBe(true)
    })
  })

  describe('mock seam (CANVAS_LLM_MOCK)', () => {
    it('returns a deterministic list including the provider default, zero egress', async () => {
      const r = await listModels(
        dir,
        'openrouter',
        false,
        deps(neverFetch, { env: { CANVAS_LLM_MOCK: '1' } })
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.models.map((m) => m.id)).toEqual([
          DEFAULT_MODELS.openrouter,
          'mock/model-a',
          'mock/model-b'
        ])
        expect(r.models[0].toolUse).toBe(true)
      }
      // Mock never touches the cache file.
      expect(existsSync(join(dir, 'llm-models-cache.json'))).toBe(false)
    })
  })

  describe('key resolution', () => {
    it('prefers the keyStore over env (store-first, same as llmService)', async () => {
      const { fetch, calls } = okFetch({ data: [] })
      const keyStore = { getKey: vi.fn(() => 'STORE-KEY') }
      await listModels(
        dir,
        'openai',
        false,
        deps(fetch, { env: { OPENAI_API_KEY: 'ENV-KEY' }, keyStore })
      )
      expect(keyStore.getKey).toHaveBeenCalledWith('openai')
      expect(calls[0].headers.Authorization).toBe('Bearer STORE-KEY')
    })
  })
})

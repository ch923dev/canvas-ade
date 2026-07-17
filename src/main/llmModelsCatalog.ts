/**
 * Model-list catalog for the Settings › Context·LLM model combobox. Fetches each provider's
 * model-list endpoint, normalizes entries to { id, label?, contextLength?, toolUse? }, and
 * caches cloud lists in userData/llm-models-cache.json (atomic write — same userData
 * discipline as llmConfig/llmBudget; NEVER a project folder). Pure I/O behind an injected
 * FetchLike + clock so it is unit-tested without the network; the mock seam (CANVAS_LLM_MOCK)
 * returns a deterministic list so e2e stays zero-egress.
 *
 * Egress discipline (this module ADDS an outbound path, so the LLM egress rules apply):
 * - BUG-001 (SSRF): the local provider's baseUrl comes from the persisted config ONLY (never
 *   the renderer) and is re-checked against isLoopbackBaseUrl here — last line of defense.
 * - BUG-003 (data leak): fetch/parse failures surface as a typed { ok:false } with NO message —
 *   a provider error body is never echoed toward IPC.
 * - List calls do NOT consume the daily summarize budget (not completions); the 1 h cache
 *   bounds egress instead. The local provider is never cached (its model set changes when the
 *   user pulls/deletes models locally).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { LlmConfig, ProviderName } from './llmConfig'
import { DEFAULT_MODELS, isLoopbackBaseUrl, readLlmConfig } from './llmConfig'
import type { KeyStore } from './llmKeyStore'
import { isMockEnabled, keyForProvider } from './llmService'

/** One selectable model. `toolUse` is a tri-state: true/false when known, absent when unknown. */
export interface LlmModelEntry {
  id: string
  /** Human display name when the provider gives one (Anthropic display_name, OpenRouter name). */
  label?: string
  contextLength?: number
  toolUse?: boolean
}

/** Typed result over IPC — mirrors SummarizeResult's discriminated-union discipline. */
export type ModelsListResult =
  | { ok: true; models: LlmModelEntry[]; fetchedAt: number; stale?: true }
  | { ok: false; reason: 'no-key' | 'no-base-url' | 'provider-error' }

/** GET-only fetch-like transport (llmService's FetchLike is POST-shaped; lists carry no body). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface ModelsCatalogDeps {
  fetch: FetchLike
  env: Record<string, string | undefined>
  /** Store-first key source, same contract as llmService. */
  keyStore?: Pick<KeyStore, 'getKey'>
  /** Injected clock so TTL math is deterministic in tests. */
  clock?: () => Date
  timeoutMs?: number
}

/** Cloud lists change slowly; 1 h keeps the combobox fresh without hammering list endpoints. */
export const CACHE_TTL_MS = 3_600_000

/** A hung list endpoint must not wedge the Settings pane — abort well before the user gives up. */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Bounds on what a provider response may put on disk / over IPC (the OpenRouter list is ~350
 * entries today; 2000 is generous headroom). Oversized lists are truncated, oversized ids
 * skipped — a hostile/buggy endpoint can't stall MAIN with a multi-MB synchronous cache write.
 */
const MAX_MODELS = 2000
const MAX_ID_LEN = 256
const MAX_LABEL_LEN = 256

const LIST_URLS: Record<Exclude<ProviderName, 'local'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  openai: 'https://api.openai.com/v1/models',
  // limit=1000 covers the full Claude catalog in one page (a few dozen models; no cursor walk).
  anthropic: 'https://api.anthropic.com/v1/models?limit=1000'
}

/**
 * OpenAI's /v1/models returns EVERY model (embeddings, whisper, tts, image, moderation…) with
 * no capability metadata — filter the obviously-non-chat families so the combobox stays usable.
 */
const OPENAI_NON_CHAT_RE =
  /(embedding|whisper|tts|dall-e|moderation|babbage|davinci|audio|realtime|transcribe|image)/

interface CacheEntry {
  fetchedAt: number
  models: LlmModelEntry[]
}

function cacheFileFor(userDataDir: string): string {
  return join(userDataDir, 'llm-models-cache.json')
}

/** Drop malformed/oversized entries — applied to provider responses AND the on-disk cache. */
function sanitizeEntries(raw: unknown): LlmModelEntry[] {
  if (!Array.isArray(raw)) return []
  const out: LlmModelEntry[] = []
  for (const m of raw) {
    if (out.length >= MAX_MODELS) break
    const e = m as Partial<LlmModelEntry>
    if (typeof e?.id !== 'string' || e.id.length === 0 || e.id.length > MAX_ID_LEN) continue
    const entry: LlmModelEntry = { id: e.id }
    if (typeof e.label === 'string' && e.label.length > 0 && e.label.length <= MAX_LABEL_LEN)
      entry.label = e.label
    if (
      typeof e.contextLength === 'number' &&
      Number.isInteger(e.contextLength) &&
      e.contextLength > 0
    )
      entry.contextLength = e.contextLength
    if (typeof e.toolUse === 'boolean') entry.toolUse = e.toolUse
    out.push(entry)
  }
  return out
}

/** Read one provider's cache entry, or null. The file is user-writable — validate everything. */
function readCache(userDataDir: string, provider: ProviderName): CacheEntry | null {
  const f = cacheFileFor(userDataDir)
  if (!existsSync(f)) return null
  try {
    const all = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Partial<CacheEntry>>
    const e = all?.[provider]
    if (!e || typeof e.fetchedAt !== 'number' || !Number.isFinite(e.fetchedAt)) return null
    const models = sanitizeEntries(e.models)
    if (models.length === 0) return null
    return { fetchedAt: e.fetchedAt, models }
  } catch {
    return null
  }
}

function writeCache(userDataDir: string, provider: ProviderName, entry: CacheEntry): void {
  const f = cacheFileFor(userDataDir)
  let all: Record<string, CacheEntry> = {}
  try {
    if (existsSync(f)) all = JSON.parse(readFileSync(f, 'utf8')) as Record<string, CacheEntry>
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {}
  } catch {
    all = {}
  }
  all[provider] = entry
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(f, JSON.stringify(all), 'utf8')
}

function parseOpenRouter(json: unknown): LlmModelEntry[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('openrouter: malformed model list')
  return sanitizeEntries(
    data.map((m) => {
      const r = m as {
        id?: unknown
        name?: unknown
        context_length?: unknown
        supported_parameters?: unknown
      }
      return {
        id: r.id,
        label: r.name,
        contextLength: r.context_length,
        toolUse: Array.isArray(r.supported_parameters)
          ? r.supported_parameters.includes('tools')
          : undefined
      } as LlmModelEntry
    })
  )
}

function parseOpenAiShape(provider: ProviderName, json: unknown): LlmModelEntry[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error(`${provider}: malformed model list`)
  const ids = data.map((m) => ({ id: (m as { id?: unknown }).id }) as LlmModelEntry)
  const entries = sanitizeEntries(ids)
  // Only openai itself needs the non-chat filter; a local server lists only what it serves.
  return provider === 'openai' ? entries.filter((e) => !OPENAI_NON_CHAT_RE.test(e.id)) : entries
}

function parseAnthropic(json: unknown): LlmModelEntry[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('anthropic: malformed model list')
  return sanitizeEntries(
    data.map((m) => {
      const r = m as { id?: unknown; display_name?: unknown }
      // Every current Claude model supports tool use; the list API carries no per-model flag.
      return { id: r.id, label: r.display_name, toolUse: true } as LlmModelEntry
    })
  )
}

/** Deterministic list for CANVAS_LLM_MOCK (e2e/CI) — includes the provider default, zero egress. */
function mockModels(provider: ProviderName): LlmModelEntry[] {
  return [
    { id: DEFAULT_MODELS[provider], toolUse: true, contextLength: 128_000 },
    { id: 'mock/model-a', toolUse: true, contextLength: 128_000 },
    { id: 'mock/model-b', contextLength: 32_000 }
  ]
}

interface ProviderListRequest {
  url: string
  headers: Record<string, string>
  parse: (json: unknown) => LlmModelEntry[]
}

/**
 * Map (provider, config, key) → the list request, or a typed refusal. Key/baseUrl resolution
 * happens MAIN-side only — the renderer sends { provider, refresh? } and nothing else.
 */
function buildListRequest(
  provider: ProviderName,
  config: LlmConfig,
  key: string | undefined
): ProviderListRequest | { reason: 'no-key' | 'no-base-url' } {
  switch (provider) {
    case 'openrouter':
      // Public, edge-cached, keyless — the default provider's combobox works out of the box.
      return { url: LIST_URLS.openrouter, headers: {}, parse: parseOpenRouter }
    case 'openai':
      if (!key) return { reason: 'no-key' }
      return {
        url: LIST_URLS.openai,
        headers: { Authorization: `Bearer ${key}` },
        parse: (j) => parseOpenAiShape('openai', j)
      }
    case 'anthropic':
      if (!key) return { reason: 'no-key' }
      return {
        url: LIST_URLS.anthropic,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        parse: parseAnthropic
      }
    case 'local': {
      if (!config.baseUrl) return { reason: 'no-base-url' }
      // BUG-001 (SSRF): last-line defense, mirroring llmService.buildRequest — never egress to a
      // non-loopback URL even if a poisoned baseUrl slipped past the write/read guards.
      if (!isLoopbackBaseUrl(config.baseUrl)) return { reason: 'no-base-url' }
      // BUG-041: strip trailing slashes so '…/v1/' yields '…/v1/models', not '…/v1//models'.
      const base = config.baseUrl.replace(/\/+$/, '')
      return {
        url: `${base}/models`,
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        parse: (j) => parseOpenAiShape('local', j)
      }
    }
  }
}

/**
 * List the selectable models for `provider`. Serve the cloud cache when fresh (unless
 * `refresh`), fetch otherwise, and fall back to a stale cache entry when the fetch fails —
 * the combobox degrades to "last known list" offline, and free text always works above it.
 */
export async function listModels(
  userDataDir: string,
  provider: ProviderName,
  refresh: boolean,
  deps: ModelsCatalogDeps
): Promise<ModelsListResult> {
  const now = (deps.clock ?? (() => new Date()))().getTime()
  if (isMockEnabled(deps.env)) return { ok: true, models: mockModels(provider), fetchedAt: now }

  const config = readLlmConfig(userDataDir)
  const key = keyForProvider(provider, deps.env, deps.keyStore)
  const req = buildListRequest(provider, config, key)
  if ('reason' in req) return { ok: false, reason: req.reason }

  const cacheable = provider !== 'local'
  if (cacheable && !refresh) {
    const cached = readCache(userDataDir, provider)
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS)
      return { ok: true, models: cached.models, fetchedAt: cached.fetchedAt }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await deps.fetch(req.url, {
        method: 'GET',
        headers: req.headers,
        signal: controller.signal
      })
      // BUG-003: never surface the response body — a failed list call yields a typed refusal only.
      if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`)
      const models = req.parse(await res.json())
      if (cacheable) writeCache(userDataDir, provider, { fetchedAt: now, models })
      return { ok: true, models, fetchedAt: now }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    if (cacheable) {
      const cached = readCache(userDataDir, provider)
      if (cached)
        return { ok: true, models: cached.models, fetchedAt: cached.fetchedAt, stale: true }
    }
    return { ok: false, reason: 'provider-error' }
  }
}

# M-brain T-B1 — Provider-agnostic LLM Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Electron MAIN a provider-agnostic `summarize(input) → text` engine (OpenRouter default; OpenAI / Anthropic / local), reachable from the renderer over a guarded `llm:summarize` / `llm:status` IPC bridge, that degrades gracefully to a typed no-provider result when no key is configured.

**Architecture:** One MAIN module `llmService.ts` holds a minimal `Provider` interface plus pure per-provider request-builders / response-parsers, a `getProvider(config, deps)` factory (returns `null` → no-provider), and a `runSummarize` orchestrator that the IPC handler calls. Provider + model (NO key) persist in `userData` via `llmConfig.ts` (mirrors `recentProjects.ts`). The API key is read from an **env var** for T-B1 (`safeStorage` is T-B2); it is never read from or written to the project folder. All network I/O goes through an injected `fetch`-like transport so the engine is unit-tested with a fake and e2e runs a mock provider (no real network).

**Tech Stack:** Electron 33 MAIN, TypeScript strict, Vitest (`node` env for MAIN tests), global `fetch` (Node 22 / Electron), `write-file-atomic`, the existing `CANVAS_SMOKE=e2e` in-process harness.

---

## Settled design decisions (the 5 kickoff notes — locked here, do not re-pick mid-build)

1. **Key source (T-B1):** read from an env var per provider — `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optional `LLM_LOCAL_API_KEY` (local may need none). T-B2 swaps in `safeStorage`. The key is **never** read/written under the project folder / `.canvas/` / `canvas.json`. `llmConfig.ts` persists only provider + model + optional local baseUrl in `userData`.
2. **Mock seam (e2e):** `isMockEnabled(env)` is true when `env.CANVAS_LLM_MOCK === '1'` **or** `env.CANVAS_SMOKE === 'e2e'`. When on, `getProvider` returns a `MockProvider` that resolves `` `[mock] ${input.text}` `` with **no network call**. This guarantees CI/e2e never makes a real request even though the harness does not set a key. Unit tests inject a fake `fetch` directly (never the network).
3. **Egress isolation:** the one new outbound call (MAIN → LLM endpoint) lives **only** inside the real `Provider.summarize`, behind the `Provider` interface, so the budget guard + egress ADR (T-B3) bolt on without touching callers. No change to `contextIsolation` / `sandbox` / `nodeIntegration`.
4. **Passive output:** `llmService` is pure I/O — it returns text and **never** executes or acts on model output. No tool-call / action capability is added here (the untrusted-passive rule is enforced at the memory layer later).
5. **Provider interface shape:** `interface Provider { summarize(input: SummarizeInput): Promise<string> }`, factory `getProvider(config, deps): Provider | null` (null → no-provider). OpenRouter / OpenAI / local share the OpenAI `chat/completions` shape; Anthropic uses the `messages` shape. The IPC-facing result is a discriminated union `SummarizeResult` (the "typed NoProvider" crosses IPC as `{ ok:false, reason:'no-provider' }` — thrown Error classes don't serialize cleanly over IPC).

**Out of scope (do NOT build):** `safeStorage` key store + Settings modal (T-B2); budget guard + egress ADR (T-B3); the `.canvas/` memory engine + autosummary loop (M-memory). Also: do **not** consolidate the three existing `isForeignSender` copies (pty/preview/project) — `llmService` adds its own to match the established per-module convention; consolidation is a separate refactor, not T-B1.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/llmConfig.ts` (new) | Pure userData config I/O: `readLlmConfig` / `writeLlmConfig`, `DEFAULT_MODELS`, `LlmConfig` type. Mirrors `recentProjects.ts`. No key. |
| `src/main/llmConfig.test.ts` (new) | Config defaults / round-trip / unknown-provider-rejection / project-dir-isolation. |
| `src/main/llmService.ts` (new) | `Provider` interface, per-provider `buildRequest` / `parseResponse` (pure), key resolution, mock seam, `getProvider`, `runSummarize`, `isForeignSender`, `registerLlmHandlers`. |
| `src/main/llmService.test.ts` (new) | Request shapes, response parse, key/mock/factory, `runSummarize` (fake fetch — asserts no network), guard, handler round-trip. |
| `src/preload/index.ts` (modify) | Add a guarded `llm: { summarize, status }` namespace to `api`. |
| `src/main/index.ts` (modify) | `registerLlmHandlers(ipcMain, () => mainWindow, app.getPath('userData'))`; env-gated dev ping. |
| `src/main/e2e/probes/context.ts` (modify) | Add a `contextBrain` probe (mock provider) asserting the `llm:summarize` IPC round-trip. |
| `src/main/e2e/index.ts` (modify) | Register `contextBrain` in the PLAYLIST. |

---

## Task 1: `llmConfig.ts` — provider/model config in userData (no key)

**Files:**
- Create: `src/main/llmConfig.ts`
- Test: `src/main/llmConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/llmConfig.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLlmConfig, writeLlmConfig, DEFAULT_MODELS } from './llmConfig'

describe('llmConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmcfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the OpenRouter default when no file exists', () => {
    const cfg = readLlmConfig(dir)
    expect(cfg.provider).toBe('openrouter')
    expect(cfg.model).toBe(DEFAULT_MODELS.openrouter)
  })

  it('round-trips a written provider + model', () => {
    writeLlmConfig(dir, { provider: 'anthropic', model: 'claude-3-5-haiku-latest' })
    const cfg = readLlmConfig(dir)
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.model).toBe('claude-3-5-haiku-latest')
  })

  it('falls back to defaults when an unknown provider is persisted', () => {
    writeLlmConfig(dir, { provider: 'bogus' as never, model: '' })
    const cfg = readLlmConfig(dir)
    expect(cfg.provider).toBe('openrouter')
    expect(cfg.model).toBe(DEFAULT_MODELS.openrouter)
  })

  it('writes the config file (llm-config.json) into the given userData dir, never elsewhere', () => {
    writeLlmConfig(dir, { provider: 'openai', model: 'gpt-4o-mini' })
    expect(existsSync(join(dir, 'llm-config.json'))).toBe(true)
    const raw = readFileSync(join(dir, 'llm-config.json'), 'utf8')
    expect(raw).not.toMatch(/api[_-]?key/i) // never persists key material
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/llmConfig.test.ts`
Expected: FAIL — `Cannot find module './llmConfig'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/main/llmConfig.ts
/**
 * Provider/model config for the LLM brain (T-B1), stored in the app's userData dir
 * (NEVER a project folder). Pure file I/O keyed by an explicit userDataDir so it is
 * testable without Electron's `app`. The API KEY is NOT stored here — for T-B1 the key
 * is an env var; T-B2 adds safeStorage. Mirrors recentProjects.ts.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export type ProviderName = 'openrouter' | 'openai' | 'anthropic' | 'local'

/** Cheap/fast-class defaults — user-overridable via config (and later the Settings modal). */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openrouter: 'google/gemini-2.0-flash-001',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  local: 'local-model'
}

const PROVIDERS: ProviderName[] = ['openrouter', 'openai', 'anthropic', 'local']

export interface LlmConfig {
  provider: ProviderName
  model: string
  /** Base URL for the `local` provider only (e.g. http://127.0.0.1:1234/v1). */
  baseUrl?: string
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'llm-config.json')
}

function defaults(): LlmConfig {
  return { provider: 'openrouter', model: DEFAULT_MODELS.openrouter }
}

/** Read the persisted config, repairing an unknown/blank provider to the default. */
export function readLlmConfig(userDataDir: string): LlmConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return defaults()
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<LlmConfig>
    const provider = PROVIDERS.includes(p.provider as ProviderName)
      ? (p.provider as ProviderName)
      : 'openrouter'
    const model = typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_MODELS[provider]
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : undefined
    return { provider, model, baseUrl }
  } catch {
    return defaults()
  }
}

/** Persist provider + model (+ optional baseUrl). Atomic write, like recentProjects. */
export function writeLlmConfig(userDataDir: string, cfg: LlmConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(cfg, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/llmConfig.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmConfig.ts src/main/llmConfig.test.ts
git commit -m "feat(context): T-B1 llmConfig — provider/model config in userData (no key)"
```

---

## Task 2: Per-provider request builders + response parsers (pure)

**Files:**
- Modify: `src/main/llmService.ts` (create)
- Test: `src/main/llmService.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/llmService.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `Cannot find module './llmService'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/main/llmService.ts
/**
 * T-B1: provider-agnostic LLM brain for MAIN. summarize(input) → text behind a small
 * Provider interface; OpenRouter (default) / OpenAI / local share the OpenAI
 * chat/completions shape, Anthropic uses the messages shape. Pure I/O: it returns text
 * and NEVER acts on the model output (passive-output rule). The one outbound call lives
 * only inside the real Provider.summarize, behind the interface, so the T-B3 budget
 * guard + egress ADR bolt on without touching callers. Network goes through an injected
 * fetch-like transport so this is unit-tested with a fake and e2e runs a mock provider.
 */
import type { LlmConfig, ProviderName } from './llmConfig'

export type { ProviderName }

/** Minimal, stable summarize input — a system instruction + the text to summarize. */
export interface SummarizeInput {
  system?: string
  text: string
}

/** Anthropic requires max_tokens; summaries are short. */
const SUMMARY_MAX_TOKENS = 1024

const OPENAI_SHAPE_BASE: Record<Exclude<ProviderName, 'anthropic' | 'local'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1'
}

export interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: string
}

function chatMessages(input: SummarizeInput): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = []
  if (input.system) msgs.push({ role: 'system', content: input.system })
  msgs.push({ role: 'user', content: input.text })
  return msgs
}

/** Pure: map (provider, config, key, input) → the exact HTTP request to send. */
export function buildRequest(
  provider: ProviderName,
  config: LlmConfig,
  key: string,
  input: SummarizeInput
): ProviderRequest {
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: SUMMARY_MAX_TOKENS,
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: 'user', content: input.text }]
      })
    }
  }
  // OpenAI-compatible shape (openrouter / openai / local)
  const base = provider === 'local' ? (config.baseUrl ?? '') : OPENAI_SHAPE_BASE[provider]
  return {
    url: `${base}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ model: config.model, messages: chatMessages(input) })
  }
}

/** Pure: extract the summary text from a provider's JSON response, or throw if malformed. */
export function parseResponse(provider: ProviderName, json: unknown): string {
  const j = json as Record<string, unknown>
  if (provider === 'anthropic') {
    const content = j.content as { type?: string; text?: string }[] | undefined
    const text = content?.find((c) => c.type === 'text')?.text ?? content?.[0]?.text
    if (typeof text !== 'string') throw new Error('anthropic: no content text in response')
    return text
  }
  const choices = j.choices as { message?: { content?: string } }[] | undefined
  const text = choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error(`${provider}: no choices[0].message.content`)
  return text
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: PASS (request + parse tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -m "feat(context): T-B1 per-provider request builders + response parsers"
```

---

## Task 3: Key resolution + mock seam + `getProvider` factory

**Files:**
- Modify: `src/main/llmService.ts`
- Test: `src/main/llmService.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to src/main/llmService.test.ts
import { getProvider, isMockEnabled, keyForProvider, type ProviderDeps } from './llmService'

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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `getProvider`, `isMockEnabled`, `keyForProvider`, `ProviderDeps` not exported.

- [ ] **Step 3: Write minimal implementation (append to `llmService.ts`)**

```typescript
// append to src/main/llmService.ts

/** Minimal fetch-like transport so the engine is testable without the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export interface ProviderDeps {
  fetch: FetchLike
  env: Record<string, string | undefined>
}

export interface Provider {
  summarize(input: SummarizeInput): Promise<string>
}

const KEY_ENV: Record<ProviderName, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'LLM_LOCAL_API_KEY'
}

/** The configured API key for a provider, from its env var (T-B1; safeStorage = T-B2). */
export function keyForProvider(
  provider: ProviderName,
  env: Record<string, string | undefined>
): string | undefined {
  return env[KEY_ENV[provider]]
}

/** Mock is on for e2e/CI so no real network call is ever made. */
export function isMockEnabled(env: Record<string, string | undefined>): boolean {
  return env.CANVAS_LLM_MOCK === '1' || env.CANVAS_SMOKE === 'e2e'
}

/**
 * Build a Provider for the config, or null → no-provider (callers fall back to Tier 1).
 * Mock seam first (e2e/CI), then key presence. `local` may run without a key.
 */
export function getProvider(config: LlmConfig, deps: ProviderDeps): Provider | null {
  if (isMockEnabled(deps.env)) {
    return { summarize: (input) => Promise.resolve(`[mock] ${input.text}`) }
  }
  const key = keyForProvider(config.provider, deps.env)
  if (config.provider !== 'local' && !key) return null
  return {
    async summarize(input: SummarizeInput): Promise<string> {
      const req = buildRequest(config.provider, config, key ?? '', input)
      const res = await deps.fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body
      })
      if (!res.ok) throw new Error(`${config.provider} HTTP ${res.status}: ${await res.text()}`)
      return parseResponse(config.provider, await res.json())
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -m "feat(context): T-B1 getProvider factory + key/env resolution + mock seam"
```

---

## Task 4: `runSummarize` orchestrator (typed result, no-provider + provider-error)

**Files:**
- Modify: `src/main/llmService.ts`
- Test: `src/main/llmService.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to src/main/llmService.test.ts
import { runSummarize, type SummarizeResult } from './llmService'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `runSummarize` / `SummarizeResult` not exported.

- [ ] **Step 3: Write minimal implementation (append)**

```typescript
// append to src/main/llmService.ts

/** The "typed NoProvider" travels over IPC as a discriminated union (Errors don't serialize). */
export type SummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'provider-error'; message: string }

/**
 * Orchestrate one summarize: pick a provider (null → no-provider), call it, and map any
 * failure to a typed result. NEVER throws — callers fall back to Tier 1; the app never
 * blocks on the brain.
 */
export async function runSummarize(
  config: LlmConfig,
  input: SummarizeInput,
  deps: ProviderDeps
): Promise<SummarizeResult> {
  const provider = getProvider(config, deps)
  if (!provider) return { ok: false, reason: 'no-provider' }
  try {
    return { ok: true, text: await provider.summarize(input) }
  } catch (err) {
    return { ok: false, reason: 'provider-error', message: (err as Error).message }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -m "feat(context): T-B1 runSummarize orchestrator (typed no-provider/provider-error)"
```

---

## Task 5: `isForeignSender` + `registerLlmHandlers` (IPC) + `llm:status`

**Files:**
- Modify: `src/main/llmService.ts`
- Test: `src/main/llmService.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to src/main/llmService.test.ts
import { isForeignSender, registerLlmHandlers, type LlmStatus } from './llmService'

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
  // Minimal fake ipcMain capturing the registered handlers.
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: FAIL — `isForeignSender` / `registerLlmHandlers` / `LlmStatus` not exported.

- [ ] **Step 3: Write minimal implementation (append)**

```typescript
// append to src/main/llmService.ts
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { readLlmConfig } from './llmConfig'

/**
 * True when an IPC sender is NOT the main window's main frame (foreign → deny). Matches
 * the pty/preview/project convention (a per-module copy is intentional here; consolidating
 * the three existing copies is a separate refactor, out of T-B1 scope).
 */
export function isForeignSender(
  e: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  getMainFrame: () => BrowserWindow['webContents']['mainFrame'] | null | undefined
): boolean {
  const main = getMainFrame()
  if (!e.senderFrame) return false // synthetic/internal call — allow
  if (!main) return true // real sender but window unresolved — DENY
  return e.senderFrame !== main
}

/** Status surfaced to the renderer — provider/model + key presence, never key material. */
export interface LlmStatus {
  hasProvider: boolean
  provider: ProviderName
  model: string
}

/** Default transport: Electron/Node global fetch, adapted to FetchLike. */
const defaultDeps = (): ProviderDeps => ({
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  env: process.env as Record<string, string | undefined>
})

export function registerLlmHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  injectedDeps?: ProviderDeps
): void {
  const deps = injectedDeps ?? defaultDeps()
  const guard = (e: IpcMainInvokeEvent): boolean =>
    isForeignSender(e, () => getWin()?.webContents.mainFrame)

  ipcMain.handle('llm:summarize', async (e, input: SummarizeInput): Promise<SummarizeResult> => {
    if (guard(e)) return { ok: false, reason: 'provider-error', message: 'forbidden sender' }
    const config = readLlmConfig(userDataDir)
    return runSummarize(config, input, deps)
  })

  ipcMain.handle('llm:status', (e): LlmStatus => {
    const config = readLlmConfig(userDataDir)
    if (guard(e)) return { hasProvider: false, provider: config.provider, model: config.model }
    return {
      hasProvider: getProvider(config, deps) !== null,
      provider: config.provider,
      model: config.model
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/llmService.test.ts`
Expected: PASS (all llmService tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/llmService.ts src/main/llmService.test.ts
git commit -m "feat(context): T-B1 llm IPC handlers (summarize/status) + sender guard"
```

---

## Task 6: Preload bridge — `llm.summarize` / `llm.status`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the typed bridge to the `api` object**

Add this namespace inside the `api` object in `src/preload/index.ts` (e.g. after the `export` group, before the closing `}` of `api`). The types mirror the MAIN module but are re-declared so preload stays decoupled from `src/main` (same convention the file already uses for `PtyState` / `PreviewEvent`):

```typescript
  // ── M-brain T-B1: provider-agnostic LLM summarize (MAIN owns the key/egress) ──
  llm: {
    summarize: (input: { system?: string; text: string }): Promise<LlmSummarizeResult> =>
      ipcRenderer.invoke('llm:summarize', input),
    status: (): Promise<LlmStatus> => ipcRenderer.invoke('llm:status')
  }
```

And add these type declarations near the other preload-local types (e.g. just above `const api = {`):

```typescript
// ── M-brain T-B1 — mirrors main `SummarizeResult` / `LlmStatus` (preload stays decoupled) ──
export type LlmSummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'provider-error'; message: string }

export interface LlmStatus {
  hasProvider: boolean
  provider: 'openrouter' | 'openai' | 'anthropic' | 'local'
  model: string
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (0 errors). `CanvasApi` now includes `llm`.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(context): T-B1 preload bridge — llm.summarize/status"
```

---

## Task 7: Wire `registerLlmHandlers` into MAIN + env-gated dev ping

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Register the handlers**

In `src/main/index.ts`, add the import near the other handler-registration imports:

```typescript
import { registerLlmHandlers, runSummarize } from './llmService'
import { readLlmConfig } from './llmConfig'
```

Then, in `app.whenReady().then(...)`, right after the existing `registerProjectHandlers(...)` line (currently `src/main/index.ts:160`), add:

```typescript
  registerLlmHandlers(ipcMain, () => mainWindow, app.getPath('userData'))
```

- [ ] **Step 2: Add the env-gated manual dev ping**

Immediately after the `registerLlmHandlers(...)` line, add the dev-only ping (the Manual verification path — no renderer UI in T-B1):

```typescript
  // Manual T-B1 check (dev-only, env-gated): `CANVAS_LLM_PING=hello pnpm start` calls
  // summarize once and logs the provider's reply to the MAIN stdout. With no key set this
  // logs the typed no-provider result (graceful degrade), proving the path end-to-end.
  if (process.env.CANVAS_LLM_PING) {
    runSummarize(
      readLlmConfig(app.getPath('userData')),
      { system: 'Reply in one short sentence.', text: process.env.CANVAS_LLM_PING },
      {
        fetch: ((url, init) => fetch(url, init)) as never,
        env: process.env as Record<string, string | undefined>
      }
    ).then((r) => console.log('LLM_PING', JSON.stringify(r)))
  }
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (both).

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(context): T-B1 register llm handlers + env-gated dev ping"
```

---

## Task 8: E2E probe — `contextBrain` (mock provider IPC round-trip)

**Files:**
- Modify: `src/main/e2e/probes/context.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Add the probe to `context.ts`**

Append a second export to `src/main/e2e/probes/context.ts` (keep the existing `context` digest probe unchanged):

```typescript
/**
 * M-brain T-B1: the LLM summarize IPC round-trip. Under CANVAS_SMOKE=e2e the MAIN
 * llmService auto-enables its mock provider (no network, no key), so summarize resolves
 * `[mock] <text>`. Drives the real preload bridge (window.api.llm) from the renderer and
 * asserts the seeded text round-trips back — proving preload → IPC → handler → provider.
 */
export const contextBrain: E2EProbe = {
  name: 'context-brain',
  async run(ctx) {
    const raw = await ctx.evalIn<string>(
      "window.api.llm.summarize({ text: 'canvas-brain-ping' }).then((r) => JSON.stringify(r))"
    )
    const status = await ctx.evalIn<string>('window.api.llm.status().then((s) => JSON.stringify(s))')
    let ok = false
    let detail = raw
    try {
      const r = JSON.parse(raw) as { ok: boolean; text?: string }
      const s = JSON.parse(status) as { hasProvider: boolean }
      ok = r.ok === true && r.text === '[mock] canvas-brain-ping' && s.hasProvider === true
      detail = `text=${r.text} hasProvider=${s.hasProvider}`
    } catch {
      /* keep raw as detail */
    }
    return { name: 'context-brain', ok, detail }
  }
}
```

- [ ] **Step 2: Register it in the PLAYLIST**

In `src/main/e2e/index.ts`, change the import on line 39 and add the probe to the PLAYLIST after `context` (it has no shared-id dependency, so last is safe):

```typescript
import { context, contextBrain } from './probes/context'
```

```typescript
  context, // M-digest T-D2: seeds 3 more + asserts the reopen digest panel
  contextBrain // M-brain T-B1: llm:summarize IPC round-trip via the mock provider
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run the e2e harness**

Run (PowerShell): `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: a line `E2E_CONTEXT-BRAIN {"name":"context-brain","ok":true,...}` and `E2E_DONE` with `ok:true` (the `browser`/`browser-gesture`/`focus-detach` trio may flake on a contended host — rerun for clean; memory `e2e-browser-trio-flake`). Reset after: `Remove-Item Env:CANVAS_SMOKE`.

- [ ] **Step 5: Commit**

```bash
git add src/main/e2e/probes/context.ts src/main/e2e/index.ts
git commit -m "test(context): T-B1 e2e context-brain — llm:summarize mock round-trip"
```

---

## Task 9: Full gate + handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-06-03-context-b1-llmservice.md`

- [ ] **Step 1: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
Expected: all green. If `format:check` flags the new files, run `pnpm format` and amend the relevant commit.

- [ ] **Step 2: Run the e2e harness one final time**

Run (PowerShell): `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_DONE` `ok:true` (`context-brain` ok:true). Then `Remove-Item Env:CANVAS_SMOKE`.

- [ ] **Step 3: Manual check (documented; optional real-key run)**

With a real key: `$env:OPENROUTER_API_KEY='sk-...'; $env:CANVAS_LLM_PING='hello'; pnpm start` → MAIN logs `LLM_PING {"ok":true,"text":"..."}`. With NO key: `$env:CANVAS_LLM_PING='hello'; pnpm start` → `LLM_PING {"ok":false,"reason":"no-provider"}` (graceful degrade). Reset envs after.

- [ ] **Step 4: Write the handoff**

Create `docs/superpowers/handoffs/2026-06-03-context-b1-llmservice.md` documenting: the `Provider` interface + `SummarizeResult`, the per-provider HTTP shapes, the env-var key convention (+ the T-B2 safeStorage swap point), the mock seam, the dev ping, gate + e2e results, and the T-B2 next-step (key storage + Settings UX).

- [ ] **Step 5: Commit, then squash-merge to `feat/context`**

```bash
git add docs/superpowers/handoffs/2026-06-03-context-b1-llmservice.md
git commit -m "docs(context): T-B1 LLM service handoff"
git checkout feat/context && git pull
git merge --squash feat/context-b1-llmservice
git commit -m "feat(context): M-brain T-B1 — provider-agnostic LLM service (#PR)"
git push
```

Then update `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (mark T-B1 done) and the `context-subsystem` memory.

---

## Self-review

- **Spec coverage (§5.2 + roadmap T-B1):** `summarize(input)→string` ✔ (Task 4); `Provider` interface + 4 providers, one HTTP shape each ✔ (Tasks 2–3); provider+model config in userData ✔ (Task 1); cheap/fast default, user-overridable ✔ (`DEFAULT_MODELS`); graceful degrade → typed no-provider ✔ (Task 4, `SummarizeResult`); guarded `llm:summarize`/`llm:status` bridge ✔ (Tasks 5–6); register handlers in index.ts ✔ (Task 7); e2e mock-provider round-trip ✔ (Task 8); manual real-key dev trigger → MAIN log ✔ (Task 7 ping + Task 9 step 3). **Deferred correctly:** safeStorage/Settings (T-B2), budget guard + egress ADR (T-B3), `.canvas/` loop (M-memory) — none built here.
- **Key-in-userData/env only (locked rule):** key never touches the project folder — `llmConfig.ts` persists no key (Task 1 test asserts the file is key-free); key resolves from env only (Task 3).
- **Security model untouched:** no change to `contextIsolation`/`sandbox`/`nodeIntegration`; egress isolated behind `Provider.summarize`; sender-guarded handlers.
- **Type consistency:** `SummarizeInput`, `SummarizeResult`, `LlmConfig`, `ProviderName`, `ProviderDeps`, `Provider`, `LlmStatus`, `getProvider`, `runSummarize`, `buildRequest`, `parseResponse`, `keyForProvider`, `isMockEnabled`, `registerLlmHandlers` used consistently across tasks; preload re-declares `LlmSummarizeResult`/`LlmStatus` with matching shapes.
- **Placeholder scan:** none — every code step is complete.

## Open items for the implementer (decide in-task, not silently)
- **Default model ids** (`DEFAULT_MODELS`) are cheap-tier picks (roadmap risk #3). Confirm each id is current at impl time; they are config-overridable so a stale id is a one-line fix, not a redesign.
- **OpenRouter optional headers** (`HTTP-Referer` / `X-Title` for attribution) are omitted in T-B1 — add later if rankings/attribution are wanted; not required for the call to succeed.

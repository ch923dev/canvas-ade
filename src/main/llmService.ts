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
  let base: string
  if (provider === 'local') {
    if (!config.baseUrl) throw new Error('local provider requires a baseUrl in config')
    base = config.baseUrl
  } else {
    base = OPENAI_SHAPE_BASE[provider]
  }
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
    const text = content?.find((c) => c.type === 'text')?.text
    if (typeof text !== 'string') throw new Error('anthropic: no content text in response')
    return text
  }
  const choices = j.choices as { message?: { content?: string } }[] | undefined
  const text = choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error(`${provider}: no choices[0].message.content`)
  return text
}

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

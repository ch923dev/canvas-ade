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

/**
 * Cheap/fast-class defaults — user-overridable via config (and the Settings modal).
 * Verified current 2026-06-04: gemini-2.0-flash-001 was discontinued 2026-06-01, gpt-4o-mini
 * superseded by the 4.1/5.x line. Keep this in sync with src/renderer/src/lib/llmModels.ts.
 */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openrouter: 'google/gemini-2.5-flash',
  openai: 'gpt-4.1-nano',
  anthropic: 'claude-haiku-4-5',
  local: 'local-model'
}

// Derived from DEFAULT_MODELS (typed Record<ProviderName,...>) so the provider list
// can't drift from the ProviderName union.
const PROVIDERS = Object.keys(DEFAULT_MODELS) as ProviderName[]

export interface LlmConfig {
  provider: ProviderName
  model: string
  /** Base URL for the `local` provider only (e.g. http://127.0.0.1:1234/v1). */
  baseUrl?: string
  /** Per-day LLM call cap (T-B3). */
  maxCallsPerDay?: number
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
    const model =
      typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_MODELS[provider]
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : undefined
    const maxCallsPerDay =
      typeof p.maxCallsPerDay === 'number' &&
      Number.isFinite(p.maxCallsPerDay) &&
      p.maxCallsPerDay >= 0
        ? Math.floor(p.maxCallsPerDay)
        : undefined
    return { provider, model, baseUrl, maxCallsPerDay }
  } catch {
    return defaults()
  }
}

/** Persist provider + model (+ optional baseUrl). Atomic write, like recentProjects. */
export function writeLlmConfig(userDataDir: string, cfg: LlmConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(cfg, null, 2), 'utf8')
}

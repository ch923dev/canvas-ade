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
    const model =
      typeof p.model === 'string' && p.model.length > 0 ? p.model : DEFAULT_MODELS[provider]
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

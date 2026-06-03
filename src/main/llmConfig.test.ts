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

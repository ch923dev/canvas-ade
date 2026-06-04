import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLlmConfig, writeLlmConfig, DEFAULT_MODELS, isLoopbackBaseUrl } from './llmConfig'

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

  it('round-trips the local provider baseUrl', () => {
    writeLlmConfig(dir, { provider: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' })
    const cfg = readLlmConfig(dir)
    expect(cfg.provider).toBe('local')
    expect(cfg.baseUrl).toBe('http://127.0.0.1:1234/v1')
  })

  it('writes the config file (llm-config.json) into the given userData dir, never elsewhere', () => {
    writeLlmConfig(dir, { provider: 'openai', model: 'gpt-4o-mini' })
    expect(existsSync(join(dir, 'llm-config.json'))).toBe(true)
    const raw = readFileSync(join(dir, 'llm-config.json'), 'utf8')
    expect(raw).not.toMatch(/api[_-]?key/i) // never persists key material
  })

  it('round-trips an optional maxCallsPerDay cap', () => {
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 5 })
    expect(readLlmConfig(dir).maxCallsPerDay).toBe(5)
  })

  it('omits maxCallsPerDay when not set', () => {
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm' })
    expect(readLlmConfig(dir).maxCallsPerDay).toBeUndefined()
  })

  it('rejects a negative or non-numeric cap (→ undefined)', () => {
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: -3 })
    expect(readLlmConfig(dir).maxCallsPerDay).toBeUndefined()
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: NaN })
    expect(readLlmConfig(dir).maxCallsPerDay).toBeUndefined()
  })

  // BUG-001 (SSRF): a baseUrl poisoned on disk (non-loopback / non-http) must be dropped at
  // read-time so it can never reach the egress fetch.
  it('drops a non-loopback baseUrl read from a poisoned config (BUG-001)', () => {
    writeLlmConfig(dir, {
      provider: 'local',
      model: 'm',
      baseUrl: 'http://169.254.169.254/latest/meta-data/' as string
    })
    expect(readLlmConfig(dir).baseUrl).toBeUndefined()
  })

  it('keeps a valid loopback baseUrl read from config (BUG-001)', () => {
    writeLlmConfig(dir, { provider: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' })
    expect(readLlmConfig(dir).baseUrl).toBe('http://127.0.0.1:1234/v1')
  })
})

describe('isLoopbackBaseUrl (BUG-001 egress validator)', () => {
  it('accepts loopback http(s) hosts', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://localhost:11434')).toBe(true)
    expect(isLoopbackBaseUrl('https://localhost:8443')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:1234')).toBe(true)
  })

  it('rejects non-loopback hosts, non-http schemes, and junk', () => {
    expect(isLoopbackBaseUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isLoopbackBaseUrl('http://internal-host/path')).toBe(false)
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLoopbackBaseUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackBaseUrl('data:text/plain,SECRET')).toBe(false)
    expect(isLoopbackBaseUrl('not a url')).toBe(false)
    expect(isLoopbackBaseUrl('')).toBe(false)
    expect(isLoopbackBaseUrl(undefined)).toBe(false)
    expect(isLoopbackBaseUrl(42)).toBe(false)
  })
})

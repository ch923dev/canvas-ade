/**
 * buildSpawnEnv — baseline vars, the nested-session scrub, and the v20 OpenRouter routing
 * branch (key provider seam + env set + never-break-a-spawn guards). The OpenRouter matrix is
 * the load-bearing part: a routed board must inject the full provider set; every other state
 * (disabled / no provider wired / provider throws / no key) must inject NOTHING — an ungated
 * build never wires a provider, so "no provider ⇒ no vars" IS the compile-gate contract here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSpawnEnv, setOpenRouterKeyProvider } from './ptySpawnEnv'

const OR_KEYS = [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL'
] as const

afterEach(() => setOpenRouterKeyProvider(undefined))

describe('buildSpawnEnv — baseline', () => {
  it('sets the baseline vars and scrubs nested Claude session identity', () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_SESSION_ID = 'outer'
    try {
      const env = buildSpawnEnv(undefined, { id: 'b1' })
      expect(env.FORCE_HYPERLINK).toBe('1')
      expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    } finally {
      delete process.env.CLAUDECODE
      delete process.env.CLAUDE_CODE_SESSION_ID
    }
  })

  it('a throwing recap provider never breaks the spawn env', () => {
    const env = buildSpawnEnv(
      () => {
        throw new Error('policy exploded')
      },
      { id: 'b1' }
    )
    expect(env.FORCE_HYPERLINK).toBe('1')
  })
})

describe('buildSpawnEnv — OpenRouter routing (v20)', () => {
  // buildSpawnEnv inherits process.env by design (a spawn gets the parent env). The dev box may
  // carry a real OPENROUTER_API_KEY / ANTHROPIC_* — scrub the routing keys so this suite controls
  // the baseline and "injects nothing" means "the feature added nothing", not "env was empty".
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of OR_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of OR_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('enabled + wired key injects the full provider set', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, { id: 'b1', openRouter: { enabled: true } })
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-secret')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-secret')
    // Explicitly BLANK (endpoint contract) — and it must OVERRIDE an inherited direct key.
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBeUndefined() // no model in the intent
  })

  it('enabled + model also backs ANTHROPIC_MODEL with the slug', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      openRouter: { enabled: true, model: 'anthropic/claude-sonnet-4.5' }
    })
    expect(env.ANTHROPIC_MODEL).toBe('anthropic/claude-sonnet-4.5')
  })

  it('an inherited ANTHROPIC_API_KEY is overridden to blank on a routed spawn', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-direct'
    try {
      setOpenRouterKeyProvider(() => 'sk-or-secret')
      const env = buildSpawnEnv(undefined, { id: 'b1', openRouter: { enabled: true } })
      expect(env.ANTHROPIC_API_KEY).toBe('')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('disabled / absent intent injects nothing', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    for (const openRouter of [undefined, { enabled: false }]) {
      const env = buildSpawnEnv(undefined, { id: 'b1', openRouter })
      for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
    }
  })

  it('enabled with NO provider wired injects nothing (the ungated-build contract)', () => {
    const env = buildSpawnEnv(undefined, { id: 'b1', openRouter: { enabled: true } })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
  })

  it('enabled with no stored key spawns unrouted', () => {
    setOpenRouterKeyProvider(() => undefined)
    const env = buildSpawnEnv(undefined, { id: 'b1', openRouter: { enabled: true } })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
  })

  it('a throwing key provider never breaks the spawn (unrouted, baseline intact)', () => {
    setOpenRouterKeyProvider(() => {
      throw new Error('keyring exploded')
    })
    const env = buildSpawnEnv(undefined, { id: 'b1', openRouter: { enabled: true } })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
    expect(env.FORCE_HYPERLINK).toBe('1')
  })

  it('the recap seam stays the LAST word over the routing set', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(() => ({ ANTHROPIC_BASE_URL: 'http://recap-override' }), {
      id: 'b1',
      openRouter: { enabled: true }
    })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://recap-override')
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-secret')
  })
})

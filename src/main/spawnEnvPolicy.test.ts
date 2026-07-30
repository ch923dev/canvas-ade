/**
 * spawnEnvPolicy — the P5 curated credential deny-list (A8-F3): name matching (exact +
 * prefix + the agent-auth keep guard), the pure filter, the pack→policy rule, and the
 * board-id registry's cap/persistence semantics.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  envPolicyForPack,
  filterSpawnEnvBase,
  getSpawnEnvPolicy,
  isDeniedEnvName,
  registerSpawnEnvPolicy,
  resetSpawnEnvPolicies,
  secretEnvNamesPresent
} from './spawnEnvPolicy'

afterEach(() => resetSpawnEnvPolicies())

describe('isDeniedEnvName', () => {
  it('denies exact credential names (case-insensitive)', () => {
    expect(isDeniedEnvName('GITHUB_TOKEN')).toBe(true)
    expect(isDeniedEnvName('github_token')).toBe(true)
    expect(isDeniedEnvName('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(isDeniedEnvName('DATABASE_URL')).toBe(true)
  })

  it('denies the AZURE_ credential-family prefix', () => {
    expect(isDeniedEnvName('AZURE_CLIENT_SECRET')).toBe(true)
    expect(isDeniedEnvName('AZURE_TENANT_ID')).toBe(true)
  })

  it('NEVER denies agent-auth vars — the worker CLI must still authenticate', () => {
    expect(isDeniedEnvName('ANTHROPIC_API_KEY')).toBe(false)
    expect(isDeniedEnvName('ANTHROPIC_BASE_URL')).toBe(false)
    expect(isDeniedEnvName('CLAUDE_CODE_SESSION_ID')).toBe(false)
  })

  it('leaves ordinary env alone (no broad *_TOKEN/*_KEY pattern)', () => {
    expect(isDeniedEnvName('PATH')).toBe(false)
    expect(isDeniedEnvName('MY_APP_TOKEN')).toBe(false)
    expect(isDeniedEnvName('SESSION_KEY')).toBe(false)
  })
})

describe('filterSpawnEnvBase', () => {
  const base = {
    PATH: '/usr/bin',
    GITHUB_TOKEN: 'ghp_x',
    AZURE_CLIENT_SECRET: 's',
    ANTHROPIC_API_KEY: 'sk-ant',
    EMPTYISH: undefined
  }

  it('scrub:secrets removes present deny-listed vars and reports them sorted', () => {
    const { env, scrubbed } = filterSpawnEnvBase(base, { scrub: 'secrets' })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant')
    expect(scrubbed).toEqual(['AZURE_CLIENT_SECRET', 'GITHUB_TOKEN'])
  })

  it('no policy = an untouched copy and no scrubbed names', () => {
    const { env, scrubbed } = filterSpawnEnvBase(base, undefined)
    expect(env.GITHUB_TOKEN).toBe('ghp_x')
    expect(scrubbed).toEqual([])
    expect(env).not.toBe(base) // a copy — callers mutate the result freely
  })

  it('an undefined-valued var is never reported as scrubbed', () => {
    const { scrubbed } = filterSpawnEnvBase({ GITHUB_TOKEN: undefined }, { scrub: 'secrets' })
    expect(scrubbed).toEqual([])
  })
})

describe('secretEnvNamesPresent', () => {
  it('lists only present deny-listed names, sorted', () => {
    expect(secretEnvNamesPresent({ NPM_TOKEN: 'x', PATH: '/bin', GH_TOKEN: 'y' })).toEqual([
      'GH_TOKEN',
      'NPM_TOKEN'
    ])
  })
})

describe('envPolicyForPack — the design-gate rule (deny-list, read-only roles only)', () => {
  it('plan (read-only) packs are scrubbed', () => {
    expect(envPolicyForPack({ permissionMode: 'plan' })).toEqual({ scrub: 'secrets' })
  })

  it('every write-capable posture inherits the full env', () => {
    for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(envPolicyForPack({ permissionMode })).toBeUndefined()
    }
  })

  it('an off-vocabulary posture fails OPEN to no-scrub (never break an ordinary spawn)', () => {
    expect(envPolicyForPack({ permissionMode: 'yolo' as unknown as 'plan' })).toBeUndefined()
  })
})

describe('registry', () => {
  it('register → get → clear round-trips; a restarted board keeps its policy', () => {
    registerSpawnEnvPolicy('b1', { scrub: 'secrets' })
    expect(getSpawnEnvPolicy('b1')).toEqual({ scrub: 'secrets' })
    // NOT consume-once: a respawn under the same id must still be filtered.
    expect(getSpawnEnvPolicy('b1')).toEqual({ scrub: 'secrets' })
    clearAndExpectGone('b1')
  })

  function clearAndExpectGone(id: string): void {
    resetSpawnEnvPolicies()
    expect(getSpawnEnvPolicy(id)).toBeUndefined()
  }

  it('the cap evicts the OLDEST registration, never the newest', () => {
    for (let i = 0; i < 300; i++) registerSpawnEnvPolicy(`b${i}`, { scrub: 'secrets' })
    expect(getSpawnEnvPolicy('b0')).toBeUndefined() // evicted
    expect(getSpawnEnvPolicy('b299')).toEqual({ scrub: 'secrets' })
  })

  it('an empty board id is ignored', () => {
    registerSpawnEnvPolicy('', { scrub: 'secrets' })
    expect(getSpawnEnvPolicy('')).toBeUndefined()
  })
})

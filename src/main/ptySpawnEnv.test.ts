/**
 * buildSpawnEnv — baseline vars, the nested-session scrub, and the v20 OpenRouter routing
 * branch (key provider seam + per-route env + never-break-a-spawn guards). The OpenRouter matrix
 * is the load-bearing part, on TWO axes:
 *
 *  - **state:** a routed board injects its route's env; every other state (disabled / no provider
 *    wired / provider throws / no key) injects NOTHING — an ungated build never wires a provider,
 *    so "no provider ⇒ no vars" IS the compile-gate contract here.
 *  - **route:** the env is SCOPED to the CLI on the launch line, and a launch line no route claims
 *    (a bare shell, gemini, a wrapper) injects nothing even with `enabled: true` and a live key.
 *    That second axis is the security boundary — `openRouter.enabled` is a board field the dialog
 *    does not clear when its section unmounts, and MCP-spawned boards carry no `agentKind`, so the
 *    launch line is the only trustworthy signal MAIN has.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSpawnEnv, setOpenRouterKeyProvider, setSpawnEnvPolicyProvider } from './ptySpawnEnv'

const OR_KEYS = [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL'
] as const

afterEach(() => {
  setOpenRouterKeyProvider(undefined)
  setSpawnEnvPolicyProvider(undefined)
})

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

describe('buildSpawnEnv — flicker-free / alt-screen (T1d)', () => {
  const ALT = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'
  afterEach(() => delete process.env[ALT])

  it('OFF (omitted / false) forces alt-screen off — DISABLE_ALTERNATE_SCREEN=1', () => {
    expect(buildSpawnEnv(undefined, { id: 'b1' })[ALT]).toBe('1')
    expect(buildSpawnEnv(undefined, { id: 'b1', flickerFree: false })[ALT]).toBe('1')
  })

  it('ON omits DISABLE_ALTERNATE_SCREEN so the CLI keeps its default alt-screen', () => {
    const env = buildSpawnEnv(undefined, { id: 'b1', flickerFree: true })
    expect(env[ALT]).toBeUndefined()
  })

  it('ON deletes a value inherited from a parent Claude session (no leak past an ON)', () => {
    process.env[ALT] = '1' // Expanse launched from a claude session that set it
    const env = buildSpawnEnv(undefined, { id: 'b1', flickerFree: true })
    expect(env[ALT]).toBeUndefined()
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

  it('a routed claude launch line injects the Anthropic-skin trio and NOTHING else', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'claude',
      openRouter: { enabled: true }
    })
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-secret')
    // Explicitly BLANK (endpoint contract) — and it must OVERRIDE an inherited direct key.
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBeUndefined() // no model in the intent
    // Scoped env: claude does not read OPENROUTER_API_KEY, so a nested CLI the board's agent
    // shells out to must NOT find the maintainer's key sitting in its environment.
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
  })

  it('a routed opencode launch line injects OPENROUTER_API_KEY and NO ANTHROPIC_* vars', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'opencode --model openrouter/moonshotai/kimi-k2',
      openRouter: { enabled: true, model: 'moonshotai/kimi-k2' }
    })
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-secret')
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined() // opencode takes the model on its flag
  })

  it('enabled + model also backs ANTHROPIC_MODEL with the slug (claude)', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'claude --model anthropic/claude-sonnet-4.5',
      openRouter: { enabled: true, model: 'anthropic/claude-sonnet-4.5' }
    })
    expect(env.ANTHROPIC_MODEL).toBe('anthropic/claude-sonnet-4.5')
  })

  it('MAIN re-clamps the slug it is handed (trust boundary)', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'claude',
      openRouter: { enabled: true, model: '  anthropic/claude\nsonnet  ' }
    })
    expect(env.ANTHROPIC_MODEL).toBe('anthropic/claude sonnet')
  })

  it('an inherited ANTHROPIC_API_KEY is overridden to blank on a routed spawn', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-direct'
    try {
      setOpenRouterKeyProvider(() => 'sk-or-secret')
      const env = buildSpawnEnv(undefined, {
        id: 'b1',
        launchCommand: 'claude',
        openRouter: { enabled: true }
      })
      expect(env.ANTHROPIC_API_KEY).toBe('')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('disabled / absent intent injects nothing even on a routable launch line', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    for (const openRouter of [undefined, { enabled: false }]) {
      const env = buildSpawnEnv(undefined, { id: 'b1', launchCommand: 'claude', openRouter })
      for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
    }
  })

  // 🔒 The security axis (the defect this suite previously could not see): a live key + an
  // `enabled: true` board field must still inject NOTHING when what actually runs cannot honour a
  // route. A bare shell is the worst case — `env` prints the key and every child inherits it.
  it.each([
    ['no launch line at all (a bare interactive shell)', undefined],
    ['an empty launch line', '   '],
    ['a non-agent shell command', 'pwsh'],
    ['gemini (no OpenRouter path)', 'gemini -m gemini-2.5-pro'],
    ['a wrapper around a routable bin', 'npx claude'],
    ['a shell -c wrapper around a routable bin', 'pwsh -c claude'],
    ['an env-assignment prefix', 'FOO=1 claude']
  ])('an unroutable launch line injects nothing: %s', (_label, launchCommand) => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      ...(launchCommand !== undefined ? { launchCommand } : {}),
      openRouter: { enabled: true, model: 'anthropic/claude-sonnet-4.5' }
    })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
    expect(env.FORCE_HYPERLINK).toBe('1') // ...and the spawn is otherwise intact
  })

  it('resolves the route through a quoted absolute path and a .cmd shim', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: '"C:\\Program Files\\nodejs\\Claude.CMD" -c',
      openRouter: { enabled: true }
    })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-secret')
  })

  it('enabled with NO provider wired injects nothing (the ungated-build contract)', () => {
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'claude',
      openRouter: { enabled: true }
    })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
  })

  it('enabled with no stored key spawns unrouted', () => {
    setOpenRouterKeyProvider(() => undefined)
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'claude',
      openRouter: { enabled: true }
    })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
  })

  it('a throwing key provider never breaks the spawn (unrouted, baseline intact)', () => {
    setOpenRouterKeyProvider(() => {
      throw new Error('keyring exploded')
    })
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'claude',
      openRouter: { enabled: true }
    })
    for (const k of OR_KEYS) expect(env[k]).toBeUndefined()
    expect(env.FORCE_HYPERLINK).toBe('1')
  })

  it('the recap seam stays the LAST word over the routing set', () => {
    setOpenRouterKeyProvider(() => 'sk-or-secret')
    const env = buildSpawnEnv(() => ({ ANTHROPIC_BASE_URL: 'http://recap-override' }), {
      id: 'b1',
      launchCommand: 'claude',
      openRouter: { enabled: true }
    })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://recap-override')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-secret')
  })
})

describe('buildSpawnEnv — P5 per-board env policy (A8-F3 secrets hygiene)', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN
    delete process.env.AWS_SECRET_ACCESS_KEY
  })

  it('a scrub policy drops deny-listed inherited vars + discloses them in CANVAS_ENV_SCRUBBED', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret'
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'
    setSpawnEnvPolicyProvider((id) => (id === 'scrubbed' ? { scrub: 'secrets' } : undefined))
    const env = buildSpawnEnv(undefined, { id: 'scrubbed' })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    const disclosed = (env.CANVAS_ENV_SCRUBBED ?? '').split(',')
    expect(disclosed).toContain('GITHUB_TOKEN')
    expect(disclosed).toContain('AWS_SECRET_ACCESS_KEY')
    // Baseline injections survive the filter (it applies to the inherited base only).
    expect(env.FORCE_HYPERLINK).toBe('1')
  })

  it('a board the provider resolves NO policy for inherits everything (no disclosure var)', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret'
    setSpawnEnvPolicyProvider(() => undefined)
    const env = buildSpawnEnv(undefined, { id: 'plain' })
    expect(env.GITHUB_TOKEN).toBe('ghp_secret')
    expect(env.CANVAS_ENV_SCRUBBED).toBeUndefined()
  })

  it('deliberate OpenRouter injection survives a scrub that denies OPENROUTER_API_KEY', () => {
    setSpawnEnvPolicyProvider(() => ({ scrub: 'secrets' }))
    setOpenRouterKeyProvider(() => 'sk-or-deliberate')
    // opencode is the route that emits OPENROUTER_API_KEY (claude's route emits the Anthropic trio).
    const env = buildSpawnEnv(undefined, {
      id: 'b1',
      launchCommand: 'opencode',
      openRouter: { enabled: true }
    })
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-deliberate')
  })

  it('a throwing policy provider never breaks the spawn (full inherit, baseline intact)', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret'
    setSpawnEnvPolicyProvider(() => {
      throw new Error('registry exploded')
    })
    const env = buildSpawnEnv(undefined, { id: 'b1' })
    expect(env.GITHUB_TOKEN).toBe('ghp_secret')
    expect(env.FORCE_HYPERLINK).toBe('1')
  })
})

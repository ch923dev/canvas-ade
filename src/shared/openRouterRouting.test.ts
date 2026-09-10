/**
 * The shared OpenRouter routing table — the ONE declaration MAIN's spawn-env branch and the
 * renderer's dialog gate both read. Pure functions, so this suite carries the fiddly parsing
 * cases (quoted paths, `.cmd` shims, wrappers) and the buildSpawnEnv suite carries the env
 * matrix that uses them.
 */
import { describe, expect, it } from 'vitest'
import {
  launchBin,
  OPENROUTER_CAPABLE_PRESETS,
  OPENROUTER_KEY_ENV,
  OPENROUTER_MODEL_MAX,
  OPENROUTER_ROUTES,
  openRouterArgs,
  resolveOpenRouterRoute,
  routeByPresetId,
  sanitizeOpenRouterModel
} from './openRouterRouting'

describe('launchBin', () => {
  it('takes the bare, lowercase bin off the front of a launch line', () => {
    expect(launchBin('claude')).toBe('claude')
    expect(launchBin('claude --model anthropic/claude-sonnet-4.5')).toBe('claude')
    expect(launchBin('  opencode -c  ')).toBe('opencode')
    expect(launchBin('CLAUDE')).toBe('claude')
  })

  it('strips quotes, directories and a Windows shim extension', () => {
    expect(launchBin('"C:\\Program Files\\nodejs\\claude.cmd" -c')).toBe('claude')
    expect(launchBin("'/usr/local/bin/opencode'")).toBe('opencode')
    expect(launchBin('C:/tools/Claude.EXE')).toBe('claude')
    expect(launchBin('/usr/bin/claude.ps1')).toBe('claude')
  })

  it('is undefined for an absent or blank line (a bare interactive shell)', () => {
    expect(launchBin(undefined)).toBeUndefined()
    expect(launchBin('')).toBeUndefined()
    expect(launchBin('   ')).toBeUndefined()
  })

  it('reports the WRAPPER, not the wrapped bin — routing must fail closed on those', () => {
    expect(launchBin('npx claude')).toBe('npx')
    expect(launchBin('pwsh -c claude')).toBe('pwsh')
    expect(launchBin('FOO=1 claude')).toBe('foo=1')
  })
})

describe('resolveOpenRouterRoute', () => {
  it('resolves the routes that exist', () => {
    expect(resolveOpenRouterRoute('claude --effort high')?.id).toBe('claude')
    expect(resolveOpenRouterRoute('opencode')?.id).toBe('opencode')
    expect(resolveOpenRouterRoute('codex -c model_provider=openrouter')?.id).toBe('codex')
  })

  it('resolves NOTHING for a CLI with no OpenRouter path, a bare shell, or a wrapper', () => {
    for (const line of [undefined, '', 'pwsh', 'bash', 'gemini -m gemini-2.5-pro', 'npx claude']) {
      expect(resolveOpenRouterRoute(line)).toBeUndefined()
    }
  })

  it('the capable-preset set is exactly the routes (dialog and MAIN cannot drift)', () => {
    expect([...OPENROUTER_CAPABLE_PRESETS].sort()).toEqual(['claude', 'codex', 'opencode'])
    expect(OPENROUTER_CAPABLE_PRESETS.size).toBe(OPENROUTER_ROUTES.length)
    for (const r of OPENROUTER_ROUTES) expect(OPENROUTER_CAPABLE_PRESETS.has(r.id)).toBe(true)
  })
})

describe('route env is scoped to the CLI that reads it', () => {
  const route = (id: string): (typeof OPENROUTER_ROUTES)[number] =>
    OPENROUTER_ROUTES.find((r) => r.id === id)!

  it('claude gets the Anthropic trio (API key blank) and no OPENROUTER_API_KEY', () => {
    expect(route('claude').env('k', 'a/b')).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'k',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'a/b'
    })
    expect(route('claude').env('k')).not.toHaveProperty('ANTHROPIC_MODEL')
  })

  it('opencode gets only OPENROUTER_API_KEY (the model rides its --model flag)', () => {
    expect(route('opencode').env('k', 'a/b')).toEqual({ OPENROUTER_API_KEY: 'k' })
  })

  it('codex gets only OPENROUTER_API_KEY (the model rides -m, the provider rides -c)', () => {
    expect(route('codex').env('k', 'a/b')).toEqual({ OPENROUTER_API_KEY: 'k' })
  })
})

// The codex provider override is PROBE-VERIFIED against codex-cli 0.153.4 (see the route's
// comment): `name` is required, and `wire_api` must be ABSENT because chat / chat_completions
// break config loading on that version while responses is already the default. These assertions
// are the regression fence around both facts -- tidying this argv would silently kill routing.
describe('codex routing argv', () => {
  it('emits exactly the four verified -c overrides, in order', () => {
    expect(openRouterArgs('codex')).toEqual([
      '-c',
      'model_provider=openrouter',
      '-c',
      'model_providers.openrouter.name=OpenRouter',
      '-c',
      'model_providers.openrouter.base_url=https://openrouter.ai/api/v1',
      '-c',
      'model_providers.openrouter.env_key=OPENROUTER_API_KEY'
    ])
  })

  it('names the SAME env var the route actually injects', () => {
    expect(openRouterArgs('codex')).toContain(
      'model_providers.openrouter.env_key=' + OPENROUTER_KEY_ENV
    )
    expect(Object.keys(routeByPresetId('codex')!.env('k'))).toEqual([OPENROUTER_KEY_ENV])
  })

  it('sets no wire_api (chat / chat_completions are rejected by codex 0.153.4)', () => {
    expect(openRouterArgs('codex').join(' ')).not.toContain('wire_api')
  })

  it('never puts the key on the launch line -- these tokens persist in the board doc', () => {
    for (const model of [undefined, 'openai/gpt-5-codex']) {
      const line = openRouterArgs('codex', model).join(' ')
      expect(line).not.toMatch(/sk-|Bearer/)
      // Names the env var; never assigns a value to it.
      expect(line).not.toMatch(/OPENROUTER_API_KEY=./)
    }
  })

  it('is empty for CLIs steered by env alone, and for unknown presets', () => {
    for (const id of ['claude', 'opencode', 'gemini', 'shell', undefined]) {
      expect(openRouterArgs(id)).toEqual([])
    }
  })

  it('every route that emits argv also resolves from its own bin (no orphan argv)', () => {
    for (const r of OPENROUTER_ROUTES) {
      if (r.args) expect(resolveOpenRouterRoute(r.bin)?.id).toBe(r.id)
    }
  })
})

describe('sanitizeOpenRouterModel', () => {
  it('keeps a real slug untouched', () => {
    expect(sanitizeOpenRouterModel('anthropic/claude-sonnet-4.5')).toBe(
      'anthropic/claude-sonnet-4.5'
    )
    expect(sanitizeOpenRouterModel('z-ai/glm-4.7:exacto')).toBe('z-ai/glm-4.7:exacto')
  })

  it('drops control chars and collapses whitespace — a slug can never split a PTY line', () => {
    expect(sanitizeOpenRouterModel('  a/b  ')).toBe('a/b')
    expect(sanitizeOpenRouterModel('a/b\nrm -rf /')).toBe('a/b rm -rf /')
    expect(sanitizeOpenRouterModel('a/b\r\nx')).toBe('a/b x')
    expect(sanitizeOpenRouterModel('a\u0000/b')).toBe('a /b')
  })

  it('caps at the MCP paths’ length limit', () => {
    expect(sanitizeOpenRouterModel('x'.repeat(500))).toHaveLength(OPENROUTER_MODEL_MAX)
  })
})

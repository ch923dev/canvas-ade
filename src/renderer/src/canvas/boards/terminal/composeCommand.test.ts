import { describe, it, expect } from 'vitest'
import {
  applyOpenRouterModel,
  composeCommand,
  OPENROUTER_CAPABLE_PRESETS,
  openRouterArgs
} from './composeCommand'
import { AGENT_PRESETS, presetById } from './agentPresets'

const claude = presetById('claude')!
const shell = presetById('shell')!

describe('composeCommand', () => {
  it('shell with no values composes to empty (plain shell)', () => {
    expect(composeCommand(shell, {})).toBe('')
  })

  it('claude with no values is just the bin', () => {
    expect(composeCommand(claude, {})).toBe('claude')
  })

  it('composes selects + toggles in registry order', () => {
    expect(composeCommand(claude, { model: 'opus', effort: 'high', continue: true })).toBe(
      'claude --model opus --effort high -c'
    )
  })

  it('omits empty / false / whitespace-only values', () => {
    expect(composeCommand(claude, { model: '', continue: false, resume: '   ' })).toBe('claude')
  })

  it('emits flag + value for a text option', () => {
    expect(composeCommand(claude, { resume: 'abc123' })).toBe('claude --resume abc123')
  })

  it('quotes a value containing whitespace (path with spaces stays one arg)', () => {
    expect(composeCommand(claude, { 'add-dir': 'C:/My Project' })).toBe(
      'claude --add-dir "C:/My Project"'
    )
  })

  it('escapes backslashes in a quoted value (Windows path with spaces stays intact)', () => {
    expect(composeCommand(claude, { 'add-dir': 'C:\\Program Files\\x' })).toBe(
      'claude --add-dir "C:\\\\Program Files\\\\x"'
    )
  })

  it('escapes an embedded double-quote in a quoted value', () => {
    expect(composeCommand(claude, { resume: 'a b"c' })).toBe('claude --resume "a b\\"c"')
  })
})

// v20 OpenRouter routing: the slug overlays the model option pre-compose (pure helper).
describe('applyOpenRouterModel', () => {
  const opencode = presetById('opencode')!

  it('capability set is claude + codex + opencode (gemini has no path, shell is no agent)', () => {
    expect([...OPENROUTER_CAPABLE_PRESETS].sort()).toEqual(['claude', 'codex', 'opencode'])
  })

  it('claude composes --model with the raw slug', () => {
    const vals = applyOpenRouterModel('claude', { effort: 'high' }, 'anthropic/claude-sonnet-4.5')
    expect(composeCommand(claude, vals)).toBe(
      'claude --model anthropic/claude-sonnet-4.5 --effort high'
    )
  })

  it('opencode prefixes the provider (openrouter/<slug>)', () => {
    const vals = applyOpenRouterModel('opencode', {}, 'moonshotai/kimi-k2')
    expect(composeCommand(opencode, vals)).toBe('opencode --model openrouter/moonshotai/kimi-k2')
  })

  it('opencode keeps an already-prefixed slug as-is', () => {
    const vals = applyOpenRouterModel('opencode', {}, 'openrouter/moonshotai/kimi-k2')
    expect(vals.model).toBe('openrouter/moonshotai/kimi-k2')
  })

  it('blank slug / non-capable preset return values unchanged (same reference)', () => {
    const vals = { model: 'sonnet' }
    expect(applyOpenRouterModel('claude', vals, '')).toBe(vals)
    expect(applyOpenRouterModel('claude', vals, '   ')).toBe(vals)
    expect(applyOpenRouterModel('gemini', vals, 'x/y')).toBe(vals)
    expect(applyOpenRouterModel('shell', vals, 'x/y')).toBe(vals)
  })

  it('overlay wins over a builder-picked model without mutating the input', () => {
    const vals = { model: 'sonnet' }
    const out = applyOpenRouterModel('claude', vals, 'z-ai/glm-4.7')
    expect(out.model).toBe('z-ai/glm-4.7')
    expect(vals.model).toBe('sonnet')
  })
})

// v20 codex routing: the route's -c overrides ride the composed line between bin and options.
describe('composeCommand - OpenRouter routing argv', () => {
  it('is a pure no-op when no routing argv is passed (every pre-codex call site)', () => {
    const claude = presetById('claude')!
    expect(composeCommand(claude, { model: 'opus' })).toBe(
      composeCommand(claude, { model: 'opus' }, [])
    )
  })

  it('composes the real codex routed line: bin, then -c overrides, then -m', () => {
    const line = composeCommand(
      presetById('codex')!,
      applyOpenRouterModel('codex', {}, 'openai/gpt-5-codex'),
      openRouterArgs('codex')
    )
    expect(line).toBe(
      'codex -c model_provider=openrouter -c model_providers.openrouter.name=OpenRouter ' +
        '-c model_providers.openrouter.base_url=https://openrouter.ai/api/v1 ' +
        '-c model_providers.openrouter.env_key=OPENROUTER_API_KEY -m openai/gpt-5-codex'
    )
  })

  it('leaves the user options after the routing argv (a toggle still composes)', () => {
    const line = composeCommand(
      presetById('codex')!,
      { model: 'a/b', search: true },
      openRouterArgs('codex')
    )
    expect(line.startsWith('codex -c model_provider=openrouter')).toBe(true)
    expect(line.endsWith('-m a/b --search')).toBe(true)
  })

  it('does NOT quote the overrides - an inner = must survive verbatim', () => {
    const line = composeCommand(presetById('codex')!, {}, openRouterArgs('codex'))
    expect(line).not.toContain('"')
    expect(line).toContain('-c model_provider=openrouter')
  })

  it('every capable preset actually exists in the preset registry', () => {
    const ids = new Set(AGENT_PRESETS.map((p) => p.id))
    for (const id of OPENROUTER_CAPABLE_PRESETS) expect(ids.has(id)).toBe(true)
  })
})

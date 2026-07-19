import { describe, it, expect } from 'vitest'
import { applyOpenRouterModel, composeCommand, OPENROUTER_CAPABLE_PRESETS } from './composeCommand'
import { presetById } from './agentPresets'

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

  it('capability set is claude + opencode only (codex config-gated, gemini has no path)', () => {
    expect([...OPENROUTER_CAPABLE_PRESETS].sort()).toEqual(['claude', 'opencode'])
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

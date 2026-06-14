import { describe, it, expect } from 'vitest'
import { AGENT_PRESETS, presetById } from './agentPresets'

describe('agentPresets', () => {
  it('ships the five Quick Start presets', () => {
    expect(AGENT_PRESETS.map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
      'shell'
    ])
  })

  it('every preset carries a distinct brand glyph', () => {
    const glyphs = AGENT_PRESETS.map((p) => p.glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
    expect(glyphs.every((g) => g.startsWith('agent-'))).toBe(true)
  })

  it('Shell resolves to an empty command (plain shell)', () => {
    expect(presetById('shell')?.bin).toBe('')
    // Shell has no command-builder schema (raw command only).
    expect(presetById('shell')?.options).toBeUndefined()
  })

  it('Claude pre-fills the claude command and carries the option schema', () => {
    const claude = presetById('claude')
    expect(claude?.bin).toBe('claude')
    const ids = claude?.options?.map((o) => o.id) ?? []
    expect(ids).toContain('model')
    expect(ids).toContain('effort')
    expect(ids).toContain('permission-mode')
  })

  it('Claude options carry groups; first-appearance order is the builder tab order', () => {
    const opts = presetById('claude')?.options ?? []
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.every((o) => typeof o.group === 'string' && o.group.length > 0)).toBe(true)
    const order: string[] = []
    for (const o of opts) if (o.group && !order.includes(o.group)) order.push(o.group)
    expect(order).toEqual(['Setup', 'Session', 'Permissions', 'Context'])
  })

  it('agents with a small option set are ungrouped (flat list, no tabs)', () => {
    for (const id of ['codex', 'gemini', 'opencode']) {
      const opts = presetById(id)?.options ?? []
      expect(opts.length).toBeGreaterThan(0)
      expect(opts.every((o) => o.group === undefined)).toBe(true)
    }
  })

  it('Claude --effort exposes the real level set', () => {
    const effort = presetById('claude')?.options?.find((o) => o.id === 'effort')
    expect(effort?.kind).toBe('select')
    if (effort?.kind === 'select') {
      expect(effort.flag).toBe('--effort')
      expect(effort.choices.map((c) => c.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    }
  })

  it('presetById is undefined for an unknown / absent id', () => {
    expect(presetById('nope')).toBeUndefined()
    expect(presetById(undefined)).toBeUndefined()
  })
})

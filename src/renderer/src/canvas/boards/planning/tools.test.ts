import { describe, it, expect } from 'vitest'
import { shortcutTool, TOOL_META, type PlanTool } from './tools'

const NONE = { ctrl: false, meta: false, alt: false }

describe('shortcutTool', () => {
  it('maps each whiteboard letter to its tool', () => {
    expect(shortcutTool('s', NONE)).toBe('select')
    expect(shortcutTool('n', NONE)).toBe('note')
    expect(shortcutTool('x', NONE)).toBe('text') // PLAN-03: text=x (t is global Tidy)
    expect(shortcutTool('c', NONE)).toBe('check')
    expect(shortcutTool('d', NONE)).toBe('diagram') // PLAN-03: diagram=d
    expect(shortcutTool('a', NONE)).toBe('arrow')
    expect(shortcutTool('p', NONE)).toBe('pen')
    expect(shortcutTool('e', NONE)).toBe('erase')
  })

  it('is case-insensitive', () => {
    expect(shortcutTool('S', NONE)).toBe('select')
    expect(shortcutTool('E', NONE)).toBe('erase')
    expect(shortcutTool('X', NONE)).toBe('text')
    expect(shortcutTool('D', NONE)).toBe('diagram')
  })

  it('returns null for any modified chord (so Ctrl/Cmd/Alt shortcuts pass through)', () => {
    expect(shortcutTool('s', { ctrl: true, meta: false, alt: false })).toBeNull()
    expect(shortcutTool('a', { ctrl: false, meta: true, alt: false })).toBeNull()
    expect(shortcutTool('p', { ctrl: false, meta: false, alt: true })).toBeNull()
  })

  it('returns null for unmapped keys', () => {
    expect(shortcutTool('t', NONE)).toBeNull() // global tidy — never a board tool
    expect(shortcutTool('1', NONE)).toBeNull()
    expect(shortcutTool('z', NONE)).toBeNull()
  })

  it('never assigns the global Tidy key (t) to any tool (PLAN-03 collision check)', () => {
    expect(shortcutTool('t', NONE)).toBeNull()
    expect(Object.values(TOOL_META).some((m) => m.key === 't')).toBe(false)
  })
})

describe('TOOL_META', () => {
  it('gives every tool a human label + a unique single-letter shortcut', () => {
    const tools: PlanTool[] = [
      'select',
      'note',
      'text',
      'check',
      'diagram',
      'arrow',
      'pen',
      'erase'
    ]
    const keys = new Set<string>()
    for (const t of tools) {
      const meta = TOOL_META[t]
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.key).toMatch(/^[a-z]$/)
      keys.add(meta.key)
    }
    expect(keys.size).toBe(tools.length) // no duplicate shortcuts
  })

  it('round-trips each label key back through shortcutTool', () => {
    for (const [tool, meta] of Object.entries(TOOL_META)) {
      expect(shortcutTool(meta.key, NONE)).toBe(tool)
    }
  })
})

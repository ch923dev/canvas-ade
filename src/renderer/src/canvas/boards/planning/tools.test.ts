import { describe, it, expect } from 'vitest'
import { shortcutTool, type PlanTool } from './tools'

const NONE = { ctrl: false, meta: false, alt: false }

describe('shortcutTool', () => {
  it('maps each whiteboard letter to its tool', () => {
    expect(shortcutTool('s', NONE)).toBe('select')
    expect(shortcutTool('n', NONE)).toBe('note')
    expect(shortcutTool('c', NONE)).toBe('check')
    expect(shortcutTool('a', NONE)).toBe('arrow')
    expect(shortcutTool('p', NONE)).toBe('pen')
    expect(shortcutTool('e', NONE)).toBe('erase')
  })

  it('is case-insensitive', () => {
    expect(shortcutTool('S', NONE)).toBe('select')
    expect(shortcutTool('E', NONE)).toBe('erase')
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

  it('text is a valid PlanTool but has no bare-letter shortcut (t = canvas Tidy)', () => {
    const tool: PlanTool = 'text'
    expect(tool).toBe('text')
    expect(shortcutTool('t', { ctrl: false, meta: false, alt: false })).toBeNull()
  })
})

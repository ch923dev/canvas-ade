import { describe, it, expect } from 'vitest'
import { codeToToken, defaultHotkey, hotkeyLabel, matchesHotkey, parseHotkey } from './hotkey'

const ev = (
  code: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}
): Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'> => ({
  code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta
})

describe('parseHotkey', () => {
  it('parses the platform defaults', () => {
    expect(parseHotkey(defaultHotkey(false))).toEqual({
      code: 'KeyM',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false
    })
    expect(parseHotkey(defaultHotkey(true))).toEqual({
      code: 'KeyM',
      ctrl: false,
      shift: true,
      alt: false,
      meta: true
    })
  })

  it('parses letters, digits, F-keys and Space (case/alias-insensitive)', () => {
    expect(parseHotkey('ctrl+alt+v')?.code).toBe('KeyV')
    expect(parseHotkey('Control+7')?.code).toBe('Digit7')
    expect(parseHotkey('Alt+F9')?.code).toBe('F9')
    expect(parseHotkey('Win+Space')).toEqual({
      code: 'Space',
      ctrl: false,
      shift: false,
      alt: false,
      meta: true
    })
    expect(parseHotkey('Option+X')?.alt).toBe(true)
    expect(parseHotkey('Super+X')?.meta).toBe(true)
  })

  it('rejects unusable accelerators (fallback-to-default cases)', () => {
    expect(parseHotkey(undefined)).toBeNull()
    expect(parseHotkey('')).toBeNull()
    expect(parseHotkey('M')).toBeNull() // bare key must never hijack typing
    expect(parseHotkey('Shift+M')).toBeNull() // shift alone isn't a real modifier guard
    expect(parseHotkey('Ctrl+Shift')).toBeNull() // no key
    expect(parseHotkey('Ctrl+M+K')).toBeNull() // two keys
    expect(parseHotkey('Ctrl+Escape')).toBeNull() // outside the capture subset
  })
})

describe('matchesHotkey', () => {
  const chord = parseHotkey('Ctrl+Shift+M')!

  it('matches only the exact modifier set', () => {
    expect(matchesHotkey(ev('KeyM', { ctrl: true, shift: true }), chord)).toBe(true)
    expect(matchesHotkey(ev('KeyM', { ctrl: true }), chord)).toBe(false)
    expect(matchesHotkey(ev('KeyM', { ctrl: true, shift: true, alt: true }), chord)).toBe(false)
    expect(matchesHotkey(ev('KeyM', { ctrl: true, shift: true, meta: true }), chord)).toBe(false)
    expect(matchesHotkey(ev('KeyK', { ctrl: true, shift: true }), chord)).toBe(false)
  })
})

describe('hotkeyLabel / codeToToken', () => {
  it('labels chords per platform', () => {
    expect(hotkeyLabel(parseHotkey('Ctrl+Shift+M')!, false)).toBe('Ctrl+Shift+M')
    expect(hotkeyLabel(parseHotkey('Cmd+Shift+M')!, true)).toBe('Shift+Cmd+M')
    expect(hotkeyLabel(parseHotkey('Alt+Space')!, false)).toBe('Alt+Space')
  })

  it('codeToToken inverts the capture subset and rejects the rest', () => {
    expect(codeToToken('KeyQ')).toBe('Q')
    expect(codeToToken('Digit0')).toBe('0')
    expect(codeToToken('F12')).toBe('F12')
    expect(codeToToken('Space')).toBe('SPACE')
    expect(codeToToken('Escape')).toBeNull()
    expect(codeToToken('ControlLeft')).toBeNull()
  })
})

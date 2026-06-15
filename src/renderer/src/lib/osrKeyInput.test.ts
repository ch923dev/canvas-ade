import { describe, it, expect } from 'vitest'
import { classifyKeydown, keyCodeOf, isAltGr, type OsrKeyInfo } from './osrKeyInput'

/** Build an OsrKeyInfo with sensible defaults (no modifiers, not composing). */
function key(partial: Partial<OsrKeyInfo> & { key: string }): OsrKeyInfo {
  return {
    keyCode: undefined,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...partial
  }
}

describe('keyCodeOf', () => {
  it('maps named keys to Electron keyCodes', () => {
    expect(keyCodeOf('Enter')).toBe('Return')
    expect(keyCodeOf('ArrowUp')).toBe('Up')
    expect(keyCodeOf('Escape')).toBe('Escape')
    expect(keyCodeOf('PageDown')).toBe('PageDown')
  })
  it('passes function keys through', () => {
    expect(keyCodeOf('F1')).toBe('F1')
    expect(keyCodeOf('F12')).toBe('F12')
    expect(keyCodeOf('F13')).toBeNull() // not a real function key
  })
  it('passes single chars through; rejects lone modifiers', () => {
    expect(keyCodeOf('a')).toBe('a')
    expect(keyCodeOf('€')).toBe('€')
    expect(keyCodeOf('Shift')).toBeNull()
    expect(keyCodeOf('Dead')).toBeNull()
  })
})

describe('isAltGr', () => {
  it('detects AltGraph modifier state', () => {
    expect(isAltGr(key({ key: '€', getModifierState: (m) => m === 'AltGraph' }))).toBe(true)
  })
  it('detects the Windows Ctrl+Alt synthesis', () => {
    expect(isAltGr(key({ key: '€', ctrlKey: true, altKey: true }))).toBe(true)
  })
  it('is false for a real Ctrl+Alt+Meta chord', () => {
    expect(isAltGr(key({ key: 'a', ctrlKey: true, altKey: true, metaKey: true }))).toBe(false)
  })
  it('is false for plain Ctrl', () => {
    expect(isAltGr(key({ key: 'a', ctrlKey: true }))).toBe(false)
  })
})

describe('classifyKeydown', () => {
  it('ignores IME-in-progress keys (isComposing / keyCode 229)', () => {
    expect(classifyKeydown(key({ key: 'a', isComposing: true })).kind).toBe('ignore')
    expect(classifyKeydown(key({ key: 'Process', keyCode: 229 })).kind).toBe('ignore')
  })

  it('routes Ctrl/Cmd + C/X/V/A to clipboard', () => {
    expect(classifyKeydown(key({ key: 'c', ctrlKey: true }))).toEqual({
      kind: 'clipboard',
      action: 'copy'
    })
    expect(classifyKeydown(key({ key: 'x', ctrlKey: true }))).toEqual({
      kind: 'clipboard',
      action: 'cut'
    })
    expect(classifyKeydown(key({ key: 'v', metaKey: true }))).toEqual({
      kind: 'clipboard',
      action: 'paste'
    })
    // case-insensitive (Shift held) + selectAll
    expect(classifyKeydown(key({ key: 'A', ctrlKey: true }))).toEqual({
      kind: 'clipboard',
      action: 'selectAll'
    })
  })

  it('treats other Ctrl/Cmd chords as command (page shortcuts)', () => {
    expect(classifyKeydown(key({ key: 's', ctrlKey: true }))).toEqual({
      kind: 'command',
      keyCode: 's'
    })
    expect(classifyKeydown(key({ key: 'z', metaKey: true }))).toEqual({
      kind: 'command',
      keyCode: 'z'
    })
  })

  it('classifies named non-text keys as command', () => {
    expect(classifyKeydown(key({ key: 'Enter' }))).toEqual({ kind: 'command', keyCode: 'Return' })
    expect(classifyKeydown(key({ key: 'Tab' }))).toEqual({ kind: 'command', keyCode: 'Tab' })
    expect(classifyKeydown(key({ key: 'ArrowLeft' }))).toEqual({ kind: 'command', keyCode: 'Left' })
    expect(classifyKeydown(key({ key: 'Backspace' }))).toEqual({
      kind: 'command',
      keyCode: 'Backspace'
    })
    expect(classifyKeydown(key({ key: 'F5' }))).toEqual({ kind: 'command', keyCode: 'F5' })
  })

  it('classifies printable keys (and space) as text', () => {
    expect(classifyKeydown(key({ key: 'a' })).kind).toBe('text')
    expect(classifyKeydown(key({ key: '7' })).kind).toBe('text')
    expect(classifyKeydown(key({ key: ' ' })).kind).toBe('text') // space is text, not a command
  })

  it('AltGr text is text, NOT a command/clipboard chord (the € regression)', () => {
    // Windows synthesizes Ctrl+Alt for AltGr → € must still route to text.
    expect(classifyKeydown(key({ key: '€', ctrlKey: true, altKey: true })).kind).toBe('text')
    // Even AltGr+C must NOT be mistaken for clipboard copy.
    expect(classifyKeydown(key({ key: 'c', ctrlKey: true, altKey: true })).kind).toBe('text')
    // Via the AltGraph modifier-state signal.
    expect(classifyKeydown(key({ key: '@', getModifierState: (m) => m === 'AltGraph' })).kind).toBe(
      'text'
    )
  })

  it('ignores lone modifiers and dead keys', () => {
    expect(classifyKeydown(key({ key: 'Shift' })).kind).toBe('ignore')
    expect(classifyKeydown(key({ key: 'Control', ctrlKey: true })).kind).toBe('ignore')
    expect(classifyKeydown(key({ key: 'Dead' })).kind).toBe('ignore')
  })
})

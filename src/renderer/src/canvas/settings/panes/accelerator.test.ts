import { describe, it, expect } from 'vitest'
import { accelKey, chordFromEvent, pretty } from './accelerator'

/** Build a minimal keydown-like object with all modifiers off unless overridden. */
const ev = (
  o: Partial<{
    key: string
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
    metaKey: boolean
  }>
): { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean } => ({
  key: 'A',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...o
})

describe('accelKey', () => {
  it('uppercases a single printable character', () => {
    expect(accelKey({ key: 'k' })).toBe('K')
    expect(accelKey({ key: ']' })).toBe(']')
  })
  it('maps named keys', () => {
    expect(accelKey({ key: 'ArrowRight' })).toBe('Right')
    expect(accelKey({ key: ' ' })).toBe('Space')
    expect(accelKey({ key: 'PageDown' })).toBe('PageDown')
  })
  it('keeps function keys verbatim', () => {
    expect(accelKey({ key: 'F5' })).toBe('F5')
  })
  it('returns null for a lone modifier key', () => {
    expect(accelKey({ key: 'Control' })).toBeNull()
    expect(accelKey({ key: 'Shift' })).toBeNull()
    expect(accelKey({ key: 'Meta' })).toBeNull()
  })
})

describe('chordFromEvent', () => {
  it('maps physical Ctrl to the LITERAL Control modifier (not CommandOrControl → Cmd on macOS)', () => {
    expect(chordFromEvent(ev({ key: 'k', ctrlKey: true, altKey: true }))).toBe('Control+Alt+K')
  })
  it('maps Meta to Super', () => {
    expect(chordFromEvent(ev({ key: ']', metaKey: true }))).toBe('Super+]')
  })
  it('orders modifiers Control, Alt, Shift, Super', () => {
    expect(chordFromEvent(ev({ key: 'j', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(
      'Control+Alt+Shift+J'
    )
  })
  it('requires a strong modifier — a bare or Shift-only chord is rejected', () => {
    expect(chordFromEvent(ev({ key: 'k' }))).toBeNull()
    expect(chordFromEvent(ev({ key: 'k', shiftKey: true }))).toBeNull()
  })
  it('returns null for a lone modifier press', () => {
    expect(chordFromEvent(ev({ key: 'Alt', altKey: true }))).toBeNull()
  })
})

describe('pretty', () => {
  it('renders each modifier form readably', () => {
    expect(pretty('CommandOrControl+Alt+]')).toBe('Ctrl/⌘ + Alt + ]')
    expect(pretty('Control+Alt+K')).toBe('Ctrl + Alt + K')
    expect(pretty('Super+]')).toBe('⌘ + ]')
  })
})

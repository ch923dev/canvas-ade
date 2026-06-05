import { describe, it, expect } from 'vitest'
import { resolveTerminalKey, type TermKeyChord } from './terminalKeymap'

const chord = (key: string, mods: Partial<TermKeyChord> = {}): TermKeyChord => ({
  type: 'keydown',
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

const WIN = { hasSelection: false, isMac: false }

describe('resolveTerminalKey', () => {
  it('Shift+Enter → newline', () => {
    expect(resolveTerminalKey(chord('Enter', { shiftKey: true }), WIN)).toEqual({ kind: 'newline' })
  })

  it('plain Enter → null (xterm submits with \\r)', () => {
    expect(resolveTerminalKey(chord('Enter'), WIN)).toBeNull()
  })

  it('Ctrl+C copies ONLY with a selection; otherwise null (xterm sends SIGINT)', () => {
    expect(
      resolveTerminalKey(chord('c', { ctrlKey: true }), { hasSelection: true, isMac: false })
    ).toEqual({ kind: 'copy' })
    expect(
      resolveTerminalKey(chord('c', { ctrlKey: true }), { hasSelection: false, isMac: false })
    ).toBeNull()
  })

  it('Ctrl+V → paste (Windows/Linux)', () => {
    expect(resolveTerminalKey(chord('v', { ctrlKey: true }), WIN)).toEqual({ kind: 'paste' })
  })

  it('mac: Cmd is the primary modifier; Ctrl+C stays SIGINT even with a selection', () => {
    expect(
      resolveTerminalKey(chord('c', { metaKey: true }), { hasSelection: true, isMac: true })
    ).toEqual({ kind: 'copy' })
    expect(
      resolveTerminalKey(chord('c', { ctrlKey: true }), { hasSelection: true, isMac: true })
    ).toBeNull()
    expect(resolveTerminalKey(chord('v', { metaKey: true }), { hasSelection: false, isMac: true })).toEqual({
      kind: 'paste'
    })
  })

  it('ignores non-keydown events (handler also fires on keyup)', () => {
    expect(resolveTerminalKey(chord('Enter', { shiftKey: true, type: 'keyup' }), WIN)).toBeNull()
  })

  it('Alt+V is NOT our paste (reserved for Claude Code native image paste)', () => {
    expect(resolveTerminalKey(chord('v', { altKey: true }), WIN)).toBeNull()
  })
})

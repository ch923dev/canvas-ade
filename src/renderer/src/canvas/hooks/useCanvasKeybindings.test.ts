import { describe, it, expect } from 'vitest'
import { resolveCanvasKeyAction, type KeyChord } from './useCanvasKeybindings'

const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

const FREE = { typing: false, bareKeyAllowed: true }

describe('resolveCanvasKeyAction', () => {
  it('Ctrl+Z / Cmd+Z → undo', () => {
    expect(resolveCanvasKeyAction(chord('z', { ctrlKey: true }), FREE)).toEqual({ kind: 'undo' })
    expect(resolveCanvasKeyAction(chord('Z', { metaKey: true }), FREE)).toEqual({ kind: 'undo' })
  })

  it('Ctrl+Shift+Z → redo', () => {
    expect(resolveCanvasKeyAction(chord('z', { ctrlKey: true, shiftKey: true }), FREE)).toEqual({
      kind: 'redo'
    })
  })

  it('Ctrl+Y → redo; Ctrl+Shift+Y is not a binding', () => {
    expect(resolveCanvasKeyAction(chord('y', { ctrlKey: true }), FREE)).toEqual({ kind: 'redo' })
    expect(resolveCanvasKeyAction(chord('y', { ctrlKey: true, shiftKey: true }), FREE)).toBeNull()
  })

  it('Alt held cancels the undo/redo chord (mod requires no Alt)', () => {
    expect(resolveCanvasKeyAction(chord('z', { ctrlKey: true, altKey: true }), FREE)).toBeNull()
  })

  it('undo/redo are suppressed while typing', () => {
    expect(
      resolveCanvasKeyAction(chord('z', { ctrlKey: true }), { typing: true, bareKeyAllowed: false })
    ).toBeNull()
  })

  it('Escape clears selection (only when not typing)', () => {
    expect(resolveCanvasKeyAction(chord('Escape'), FREE)).toEqual({ kind: 'clearSelection' })
    expect(
      resolveCanvasKeyAction(chord('Escape'), { typing: true, bareKeyAllowed: false })
    ).toBeNull()
  })

  it('Ctrl/Cmd+Shift+D toggles diagnostics', () => {
    expect(resolveCanvasKeyAction(chord('d', { ctrlKey: true, shiftKey: true }), FREE)).toEqual({
      kind: 'toggleDiag'
    })
    // No Shift → not the diag toggle.
    expect(resolveCanvasKeyAction(chord('d', { ctrlKey: true }), FREE)).toBeNull()
  })

  it('1 fits / 0 resets the camera — but not inside a board node or while typing', () => {
    expect(resolveCanvasKeyAction(chord('1'), FREE)).toEqual({ kind: 'fit' })
    expect(resolveCanvasKeyAction(chord('0'), FREE)).toEqual({ kind: 'reset' })
    expect(resolveCanvasKeyAction(chord('1'), { typing: false, bareKeyAllowed: false })).toBeNull()
    expect(resolveCanvasKeyAction(chord('0'), { typing: true, bareKeyAllowed: false })).toBeNull()
  })

  it('t tidies — only with no modifier, not typing, not inside a node', () => {
    expect(resolveCanvasKeyAction(chord('t'), FREE)).toEqual({ kind: 'tidy' })
    expect(resolveCanvasKeyAction(chord('T'), FREE)).toEqual({ kind: 'tidy' })
    expect(resolveCanvasKeyAction(chord('t', { ctrlKey: true }), FREE)).toBeNull()
    expect(resolveCanvasKeyAction(chord('t'), { typing: false, bareKeyAllowed: false })).toBeNull()
  })

  it('Ctrl/Cmd+G resolves to group (not while typing)', () => {
    expect(resolveCanvasKeyAction(chord('g', { ctrlKey: true }), FREE)).toEqual({ kind: 'group' })
    expect(resolveCanvasKeyAction(chord('g', { metaKey: true }), FREE)).toEqual({ kind: 'group' })
    expect(
      resolveCanvasKeyAction(chord('g', { ctrlKey: true }), { typing: true, bareKeyAllowed: false })
    ).toBeNull()
    // Alt+Ctrl+G is a different chord — not group.
    expect(resolveCanvasKeyAction(chord('g', { ctrlKey: true, altKey: true }), FREE)).toBeNull()
  })

  it('bare f resolves to focusGroup only when bare keys are allowed', () => {
    expect(resolveCanvasKeyAction(chord('f'), FREE)).toEqual({ kind: 'focusGroup' })
    expect(resolveCanvasKeyAction(chord('f'), { typing: false, bareKeyAllowed: false })).toBeNull()
    // Modified f is not the bare focus key.
    expect(resolveCanvasKeyAction(chord('f', { ctrlKey: true }), FREE)).toBeNull()
  })

  it('returns null for unbound keys', () => {
    expect(resolveCanvasKeyAction(chord('a'), FREE)).toBeNull()
    expect(resolveCanvasKeyAction(chord('Enter'), FREE)).toBeNull()
  })
})

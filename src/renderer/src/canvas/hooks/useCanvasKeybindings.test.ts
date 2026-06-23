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

const FREE = { typing: false, bareKeyAllowed: true, boardNavAllowed: false }

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
      resolveCanvasKeyAction(chord('z', { ctrlKey: true }), {
        typing: true,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
  })

  it('Escape clears selection (only when not typing)', () => {
    expect(resolveCanvasKeyAction(chord('Escape'), FREE)).toEqual({ kind: 'clearSelection' })
    expect(
      resolveCanvasKeyAction(chord('Escape'), {
        typing: true,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
  })

  it('Ctrl/Cmd+Shift+D toggles diagnostics', () => {
    expect(resolveCanvasKeyAction(chord('d', { ctrlKey: true, shiftKey: true }), FREE)).toEqual({
      kind: 'toggleDiag'
    })
    // No Shift → not the diag toggle.
    expect(resolveCanvasKeyAction(chord('d', { ctrlKey: true }), FREE)).toBeNull()
  })

  it('Ctrl/Cmd+Shift+A toggles the audit log (W1-A) — not without Shift, not while typing', () => {
    expect(resolveCanvasKeyAction(chord('a', { ctrlKey: true, shiftKey: true }), FREE)).toEqual({
      kind: 'toggleAuditLog'
    })
    expect(resolveCanvasKeyAction(chord('A', { metaKey: true, shiftKey: true }), FREE)).toEqual({
      kind: 'toggleAuditLog'
    })
    // No Shift → not the audit toggle (and bare/Ctrl-only `a` stays free for the agent).
    expect(resolveCanvasKeyAction(chord('a', { ctrlKey: true }), FREE)).toBeNull()
    // Suppressed while typing in a field.
    expect(
      resolveCanvasKeyAction(chord('a', { ctrlKey: true, shiftKey: true }), {
        typing: true,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
  })

  it('1 fits / 0 resets the camera — but not inside a board node or while typing', () => {
    expect(resolveCanvasKeyAction(chord('1'), FREE)).toEqual({ kind: 'fit' })
    expect(resolveCanvasKeyAction(chord('0'), FREE)).toEqual({ kind: 'reset' })
    expect(
      resolveCanvasKeyAction(chord('1'), {
        typing: false,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
    expect(
      resolveCanvasKeyAction(chord('0'), {
        typing: true,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
  })

  it('t tidies — only with no modifier, not typing, not inside a node', () => {
    expect(resolveCanvasKeyAction(chord('t'), FREE)).toEqual({ kind: 'tidy' })
    expect(resolveCanvasKeyAction(chord('T'), FREE)).toEqual({ kind: 'tidy' })
    expect(resolveCanvasKeyAction(chord('t', { ctrlKey: true }), FREE)).toBeNull()
    expect(
      resolveCanvasKeyAction(chord('t'), {
        typing: false,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
  })

  it('Ctrl/Cmd+G resolves to group (not while typing)', () => {
    expect(resolveCanvasKeyAction(chord('g', { ctrlKey: true }), FREE)).toEqual({ kind: 'group' })
    expect(resolveCanvasKeyAction(chord('g', { metaKey: true }), FREE)).toEqual({ kind: 'group' })
    expect(
      resolveCanvasKeyAction(chord('g', { ctrlKey: true }), {
        typing: true,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
    // Alt+Ctrl+G is a different chord — not group.
    expect(resolveCanvasKeyAction(chord('g', { ctrlKey: true, altKey: true }), FREE)).toBeNull()
  })

  it('bare f resolves to focusGroup only when bare keys are allowed', () => {
    expect(resolveCanvasKeyAction(chord('f'), FREE)).toEqual({ kind: 'focusGroup' })
    expect(
      resolveCanvasKeyAction(chord('f'), {
        typing: false,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
    // Modified f is not the bare focus key.
    expect(resolveCanvasKeyAction(chord('f', { ctrlKey: true }), FREE)).toBeNull()
  })

  it('bare m resolves to toggleMinimap only when bare keys are allowed (D4-C)', () => {
    expect(resolveCanvasKeyAction(chord('m'), FREE)).toEqual({ kind: 'toggleMinimap' })
    expect(resolveCanvasKeyAction(chord('M'), FREE)).toEqual({ kind: 'toggleMinimap' })
    // Never from an input / focusable board surface (xterm, planning well, traps).
    expect(
      resolveCanvasKeyAction(chord('m'), {
        typing: false,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
    // Modified m is not the bare toggle key (Ctrl+M / Alt+M stay free).
    expect(resolveCanvasKeyAction(chord('m', { ctrlKey: true }), FREE)).toBeNull()
    expect(resolveCanvasKeyAction(chord('m', { altKey: true }), FREE)).toBeNull()
  })

  it('Ctrl/Cmd+K opens the palette — EVEN while typing (D4-A sign-off), not with Shift/Alt', () => {
    expect(resolveCanvasKeyAction(chord('k', { ctrlKey: true }), FREE)).toEqual({ kind: 'palette' })
    expect(resolveCanvasKeyAction(chord('K', { metaKey: true }), FREE)).toEqual({ kind: 'palette' })
    expect(
      resolveCanvasKeyAction(chord('k', { ctrlKey: true }), {
        typing: true,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toEqual({ kind: 'palette' })
    expect(resolveCanvasKeyAction(chord('k', { ctrlKey: true, shiftKey: true }), FREE)).toBeNull()
    expect(resolveCanvasKeyAction(chord('k', { ctrlKey: true, altKey: true }), FREE)).toBeNull()
    // Bare k is not a binding.
    expect(resolveCanvasKeyAction(chord('k'), FREE)).toBeNull()
  })

  it('? opens the shortcuts view — bare-key guarded like 1/0/t, Shift implied by the char', () => {
    expect(resolveCanvasKeyAction(chord('?', { shiftKey: true }), FREE)).toEqual({
      kind: 'shortcuts'
    })
    expect(resolveCanvasKeyAction(chord('?'), FREE)).toEqual({ kind: 'shortcuts' })
    expect(
      resolveCanvasKeyAction(chord('?'), {
        typing: false,
        bareKeyAllowed: false,
        boardNavAllowed: false
      })
    ).toBeNull()
    expect(resolveCanvasKeyAction(chord('?', { ctrlKey: true }), FREE)).toBeNull()
  })

  it('returns null for unbound keys', () => {
    expect(resolveCanvasKeyAction(chord('a'), FREE)).toBeNull()
    expect(resolveCanvasKeyAction(chord('Enter'), FREE)).toBeNull()
  })
})

// D4-B board nav: gated on the stricter boardNavAllowed whitelist (focus on body/pane).
const NAV = { typing: false, bareKeyAllowed: true, boardNavAllowed: true }
const NO_NAV = { typing: false, bareKeyAllowed: true, boardNavAllowed: false }

describe('resolveCanvasKeyAction — D4-B board nav', () => {
  it('Tab cycles forward, Shift+Tab backward — only when boardNavAllowed', () => {
    expect(resolveCanvasKeyAction(chord('Tab'), NAV)).toEqual({ kind: 'cycleBoard', dir: 1 })
    expect(resolveCanvasKeyAction(chord('Tab', { shiftKey: true }), NAV)).toEqual({
      kind: 'cycleBoard',
      dir: -1
    })
    expect(resolveCanvasKeyAction(chord('Tab'), NO_NAV)).toBeNull()
    // boardNavAllowed omitted (legacy ctx) behaves as false.
    expect(resolveCanvasKeyAction(chord('Tab'), FREE)).toBeNull()
  })

  it('Ctrl/Alt/Meta+Tab are not bindings (OS / future surfaces)', () => {
    expect(resolveCanvasKeyAction(chord('Tab', { ctrlKey: true }), NAV)).toBeNull()
    expect(resolveCanvasKeyAction(chord('Tab', { altKey: true }), NAV)).toBeNull()
    expect(resolveCanvasKeyAction(chord('Tab', { metaKey: true }), NAV)).toBeNull()
  })

  it('Enter focuses the selected board — bare only, gated', () => {
    expect(resolveCanvasKeyAction(chord('Enter'), NAV)).toEqual({ kind: 'focusBoard' })
    expect(resolveCanvasKeyAction(chord('Enter', { shiftKey: true }), NAV)).toBeNull()
    expect(resolveCanvasKeyAction(chord('Enter', { ctrlKey: true }), NAV)).toBeNull()
    expect(resolveCanvasKeyAction(chord('Enter'), NO_NAV)).toBeNull()
  })

  it('arrows move 1px, Shift = 10px, in the right directions', () => {
    expect(resolveCanvasKeyAction(chord('ArrowLeft'), NAV)).toEqual({
      kind: 'moveBoard',
      dx: -1,
      dy: 0
    })
    expect(resolveCanvasKeyAction(chord('ArrowRight'), NAV)).toEqual({
      kind: 'moveBoard',
      dx: 1,
      dy: 0
    })
    expect(resolveCanvasKeyAction(chord('ArrowUp', { shiftKey: true }), NAV)).toEqual({
      kind: 'moveBoard',
      dx: 0,
      dy: -10
    })
    expect(resolveCanvasKeyAction(chord('ArrowDown', { shiftKey: true }), NAV)).toEqual({
      kind: 'moveBoard',
      dx: 0,
      dy: 10
    })
  })

  it('Alt+arrows resize by the same 1/10 steps', () => {
    expect(resolveCanvasKeyAction(chord('ArrowRight', { altKey: true }), NAV)).toEqual({
      kind: 'resizeBoard',
      dw: 1,
      dh: 0
    })
    expect(
      resolveCanvasKeyAction(chord('ArrowLeft', { altKey: true, shiftKey: true }), NAV)
    ).toEqual({ kind: 'resizeBoard', dw: -10, dh: 0 })
    expect(resolveCanvasKeyAction(chord('ArrowDown', { altKey: true }), NAV)).toEqual({
      kind: 'resizeBoard',
      dw: 0,
      dh: 1
    })
  })

  it('arrows are gated by boardNavAllowed and ignore Ctrl/Meta chords', () => {
    expect(resolveCanvasKeyAction(chord('ArrowLeft'), NO_NAV)).toBeNull()
    expect(resolveCanvasKeyAction(chord('ArrowLeft', { ctrlKey: true }), NAV)).toBeNull()
    expect(resolveCanvasKeyAction(chord('ArrowLeft', { metaKey: true }), NAV)).toBeNull()
  })
})

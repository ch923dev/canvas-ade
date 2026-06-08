import { describe, it, expect } from 'vitest'
import {
  resolveTerminalKey,
  handleTerminalKey,
  TERMINAL_NEWLINE,
  type TermKeyChord,
  type TerminalKeyEffects
} from './terminalKeymap'

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
    expect(
      resolveTerminalKey(chord('v', { metaKey: true }), { hasSelection: false, isMac: true })
    ).toEqual({
      kind: 'paste'
    })
  })

  it('ignores non-keydown events (handler also fires on keyup)', () => {
    expect(resolveTerminalKey(chord('Enter', { shiftKey: true, type: 'keyup' }), WIN)).toBeNull()
  })

  it('Alt+V is NOT our paste (reserved for Claude Code native image paste)', () => {
    expect(resolveTerminalKey(chord('v', { altKey: true }), WIN)).toBeNull()
  })

  it('Ctrl+Shift+C does not copy (shiftKey guard holds; uppercase key)', () => {
    expect(
      resolveTerminalKey(chord('C', { ctrlKey: true, shiftKey: true }), {
        hasSelection: true,
        isMac: false
      })
    ).toBeNull()
  })

  it('Ctrl+- → fontDec; Ctrl+Shift+- (the real "_") is blocked (Windows)', () => {
    expect(resolveTerminalKey(chord('-', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontDec' })
    // '_' on real hardware is Shift+'-', and the font chords require no Shift — so the dec chord
    // carrying shiftKey resolves to null (no dead '_' branch needed).
    expect(resolveTerminalKey(chord('-', { ctrlKey: true, shiftKey: true }), WIN)).toBeNull()
  })
  it('Ctrl+= and Ctrl++ → fontInc (Windows)', () => {
    expect(resolveTerminalKey(chord('=', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontInc' })
    expect(resolveTerminalKey(chord('+', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontInc' })
  })
  it('Ctrl+0 → fontReset (Windows)', () => {
    expect(resolveTerminalKey(chord('0', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontReset' })
  })
  it('mac: Cmd is the primary modifier for font chords; Ctrl+- does not', () => {
    expect(
      resolveTerminalKey(chord('-', { metaKey: true }), { hasSelection: false, isMac: true })
    ).toEqual({ kind: 'fontDec' })
    expect(
      resolveTerminalKey(chord('-', { ctrlKey: true }), { hasSelection: false, isMac: true })
    ).toBeNull()
  })
  it('plain -/=/0 (no modifier) → null', () => {
    expect(resolveTerminalKey(chord('-'), WIN)).toBeNull()
    expect(resolveTerminalKey(chord('='), WIN)).toBeNull()
    expect(resolveTerminalKey(chord('0'), WIN)).toBeNull()
  })
  it('Alt+Ctrl+- → null (Alt reserved)', () => {
    expect(resolveTerminalKey(chord('-', { ctrlKey: true, altKey: true }), WIN)).toBeNull()
  })
})

describe('TERMINAL_NEWLINE (Shift+Enter byte)', () => {
  it('is LF (Ctrl+J / 0x0A) — the universal newline, NOT the ConPTY-fragile ESC+CR', () => {
    // Anthropic terminal docs (code.claude.com/docs/en/terminal-config): Ctrl+J and `\`+Enter
    // insert a newline in EVERY terminal with no setup. Ctrl+J IS byte 0x0A (LF). The previous
    // ESC+CR (`\x1b\r`, Meta/Option+Enter) form is emulator/version/ConPTY-fragile: on Windows
    // ConPTY the lone ESC can split from the CR so claude sees Escape (cancel) then CR (submit),
    // yielding no newline (the reported bug; cf. claude-code issue #9321 "OM" symptom).
    expect(TERMINAL_NEWLINE).toBe('\n')
    expect(TERMINAL_NEWLINE.charCodeAt(0)).toBe(0x0a)
    expect(TERMINAL_NEWLINE).not.toBe('\x1b\r')
  })
})

/**
 * The xterm attachCustomKeyEventHandler callback. The CRITICAL invariant these tests guard:
 * for EVERY key we own (handler returns false) we MUST call e.preventDefault(). xterm's _keyDown
 * returns early the moment our handler returns false — BEFORE xterm's own preventDefault — so
 * without our preventDefault the browser still fires the follow-up `keypress`, and for Enter that
 * keypress emits a CR (\r) that leaks to the PTY AFTER our LF → claude newlines then submits
 * (the live Shift+Enter bug a synthetic-dispatch e2e could never see — no real keypress).
 */
describe('handleTerminalKey (xterm callback — preventDefault on owned keys)', () => {
  type TestEvent = TermKeyChord & { preventDefault(): void; prevented: boolean }
  const evt = (key: string, mods: Partial<TermKeyChord> = {}): TestEvent => {
    const e = { ...chord(key, mods), prevented: false } as TestEvent
    e.preventDefault = (): void => {
      e.prevented = true
    }
    return e
  }
  const spyFx = (
    over: Partial<TerminalKeyEffects> = {}
  ): TerminalKeyEffects & {
    calls: {
      newline: number
      copy: number
      paste: number
      fontStep: number
      fontReset: number
      lastFontDelta: number
    }
  } => {
    const calls = { newline: 0, copy: 0, paste: 0, fontStep: 0, fontReset: 0, lastFontDelta: 0 }
    return {
      calls,
      newline: () => {
        calls.newline++
      },
      copySelection: () => {
        calls.copy++
        return true
      },
      paste: () => {
        calls.paste++
      },
      fontStep: (delta) => {
        calls.fontStep++
        calls.lastFontDelta = delta
      },
      fontReset: () => {
        calls.fontReset++
      },
      ...over
    }
  }

  it('Shift+Enter: preventDefault + newline + returns false (owns the key)', () => {
    const e = evt('Enter', { shiftKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true) // THE regression guard — was missing, so keypress leaked \r
    expect(fx.calls.newline).toBe(1)
  })

  it('plain Enter: returns true and does NOT preventDefault (xterm sends \\r to submit)', () => {
    const e = evt('Enter')
    expect(handleTerminalKey(e, WIN, spyFx())).toBe(true)
    expect(e.prevented).toBe(false)
  })

  it('Ctrl+V: preventDefault + paste + returns false', () => {
    const e = evt('v', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.paste).toBe(1)
  })

  it('Ctrl+C with a selection: preventDefault + copy + returns false', () => {
    const e = evt('c', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, { hasSelection: true, isMac: false }, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.copy).toBe(1)
  })

  it('Ctrl+C, selection vanished after resolve: falls through to SIGINT, NO preventDefault', () => {
    const e = evt('c', { ctrlKey: true })
    // resolve saw a selection, but copySelection finds none (race) → must let xterm send SIGINT
    const fx = spyFx({ copySelection: () => false })
    expect(handleTerminalKey(e, { hasSelection: true, isMac: false }, fx)).toBe(true)
    expect(e.prevented).toBe(false)
  })

  it('unowned key (plain letter): returns true, no preventDefault, no effects', () => {
    const e = evt('a')
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(true)
    expect(e.prevented).toBe(false)
    expect(fx.calls).toEqual({
      newline: 0,
      copy: 0,
      paste: 0,
      fontStep: 0,
      fontReset: 0,
      lastFontDelta: 0
    })
  })

  it('Ctrl+-: preventDefault + fontStep(-1) + returns false', () => {
    const e = evt('-', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.fontStep).toBe(1)
    expect(fx.calls.lastFontDelta).toBe(-1)
  })
  it('Ctrl+=: preventDefault + fontStep(+1) + returns false', () => {
    const e = evt('=', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.fontStep).toBe(1)
    expect(fx.calls.lastFontDelta).toBe(1)
  })
  it('Ctrl+0: preventDefault + fontReset + returns false', () => {
    const e = evt('0', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.fontReset).toBe(1)
  })
})

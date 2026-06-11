// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_FONT,
  MAX_TERMINAL_FONT,
  MIN_TERMINAL_FONT,
  clampTerminalFont,
  effectiveTerminalFont,
  readStickyFont,
  resolveInitialFont,
  writeStickyFont
} from './terminalFont'

afterEach(() => window.localStorage.clear())

describe('clampTerminalFont', () => {
  it('clamps to [MIN, MAX]', () => {
    expect(clampTerminalFont(2)).toBe(MIN_TERMINAL_FONT)
    expect(clampTerminalFont(99)).toBe(MAX_TERMINAL_FONT)
    expect(clampTerminalFont(14)).toBe(14)
  })
  it('returns the default for non-finite input', () => {
    expect(clampTerminalFont(NaN)).toBe(DEFAULT_TERMINAL_FONT)
    expect(clampTerminalFont(Infinity)).toBe(DEFAULT_TERMINAL_FONT)
  })
})

describe('sticky store', () => {
  it('reads the default when unset', () => {
    expect(readStickyFont()).toBe(DEFAULT_TERMINAL_FONT)
  })
  it('round-trips a written value, clamped', () => {
    writeStickyFont(11)
    expect(readStickyFont()).toBe(11)
    writeStickyFont(99)
    expect(readStickyFont()).toBe(MAX_TERMINAL_FONT)
  })
  it('falls back to the default on garbage', () => {
    window.localStorage.setItem('ca.terminal.fontSize', 'not-a-number')
    expect(readStickyFont()).toBe(DEFAULT_TERMINAL_FONT)
  })
})

describe('resolveInitialFont', () => {
  it('uses the board pin when present (clamped)', () => {
    writeStickyFont(11)
    expect(resolveInitialFont(16)).toBe(16)
  })
  it('clamps an out-of-range board pin', () => {
    expect(resolveInitialFont(999)).toBe(MAX_TERMINAL_FONT)
    expect(resolveInitialFont(2)).toBe(MIN_TERMINAL_FONT)
  })
  it('falls back to the sticky default when the pin is absent', () => {
    writeStickyFont(11)
    expect(resolveInitialFont(undefined)).toBe(11)
  })
})

// FREEZE re-raster (docs/research/2026-06-12-terminal-native-reraster-audit.md):
// the effective RENDER font is pinned x counterScale -- fractional and unclamped in
// effective space (proportionality is the FREEZE invariant), clamped in PINNED space.
describe('effectiveTerminalFont', () => {
  it('is pinned x counterScale, fractional allowed', () => {
    expect(effectiveTerminalFont(12.5, 0.82)).toBeCloseTo(10.25, 10)
    expect(effectiveTerminalFont(12.5, 1.3)).toBeCloseTo(16.25, 10)
    expect(effectiveTerminalFont(12.5, 1)).toBe(12.5)
  })
  it('clamps the PINNED input, never the effective output', () => {
    // pin clamps to MAX (22); effective may exceed MAX at zoom-in...
    expect(effectiveTerminalFont(99, 2)).toBe(MAX_TERMINAL_FONT * 2)
    // ...and fall below MIN at zoom-out (the grid must track the wrapper).
    expect(effectiveTerminalFont(2, 0.5)).toBe(MIN_TERMINAL_FONT * 0.5)
  })
  it('treats an unusable counterScale as identity', () => {
    expect(effectiveTerminalFont(12.5, NaN)).toBe(12.5)
    expect(effectiveTerminalFont(12.5, 0)).toBe(12.5)
    expect(effectiveTerminalFont(12.5, -3)).toBe(12.5)
    expect(effectiveTerminalFont(12.5, Infinity)).toBe(12.5)
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  SCROLLBACK_PRESETS,
  clampScrollback,
  readStickyScrollback,
  resolveInitialScrollback,
  writeStickyScrollback
} from './terminalScrollback'

afterEach(() => window.localStorage.clear())

describe('clampScrollback', () => {
  it('clamps to [MIN, MAX]', () => {
    expect(clampScrollback(-50)).toBe(MIN_TERMINAL_SCROLLBACK)
    expect(clampScrollback(999_999)).toBe(MAX_TERMINAL_SCROLLBACK)
    expect(clampScrollback(10_000)).toBe(10_000)
  })
  it('floors fractional input to an integer', () => {
    expect(clampScrollback(2000.9)).toBe(2000)
  })
  it('returns the default for non-finite input', () => {
    expect(clampScrollback(NaN)).toBe(DEFAULT_TERMINAL_SCROLLBACK)
    expect(clampScrollback(Infinity)).toBe(DEFAULT_TERMINAL_SCROLLBACK)
  })
})

describe('SCROLLBACK_PRESETS', () => {
  it('are all within bounds and include the default', () => {
    expect(SCROLLBACK_PRESETS).toContain(DEFAULT_TERMINAL_SCROLLBACK)
    for (const p of SCROLLBACK_PRESETS) {
      expect(clampScrollback(p)).toBe(p)
    }
  })
})

describe('sticky store', () => {
  it('reads the default when unset', () => {
    expect(readStickyScrollback()).toBe(DEFAULT_TERMINAL_SCROLLBACK)
  })
  it('round-trips a written value, clamped', () => {
    writeStickyScrollback(10_000)
    expect(readStickyScrollback()).toBe(10_000)
    writeStickyScrollback(999_999)
    expect(readStickyScrollback()).toBe(MAX_TERMINAL_SCROLLBACK)
  })
  it('falls back to the default on garbage', () => {
    window.localStorage.setItem('ca.terminal.scrollback', 'not-a-number')
    expect(readStickyScrollback()).toBe(DEFAULT_TERMINAL_SCROLLBACK)
  })
})

describe('resolveInitialScrollback', () => {
  it('uses the board pin when present (clamped)', () => {
    writeStickyScrollback(10_000)
    expect(resolveInitialScrollback(50_000)).toBe(50_000)
  })
  it('clamps an out-of-range board pin', () => {
    expect(resolveInitialScrollback(999_999)).toBe(MAX_TERMINAL_SCROLLBACK)
    expect(resolveInitialScrollback(-1)).toBe(MIN_TERMINAL_SCROLLBACK)
  })
  it('falls back to the sticky default when the pin is absent', () => {
    writeStickyScrollback(10_000)
    expect(resolveInitialScrollback(undefined)).toBe(10_000)
  })
})

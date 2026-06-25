// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_THEMES,
  TERMINAL_FONT_FAMILIES,
  DEFAULT_TERMINAL_THEME_ID,
  DEFAULT_TERMINAL_FONT_FAMILY_ID,
  terminalThemeColors,
  resolveTerminalFontFamily,
  readStickyThemeId,
  writeStickyThemeId,
  readStickyFontFamilyId,
  writeStickyFontFamilyId,
  resolveInitialThemeId,
  resolveInitialFontFamilyId
} from './terminalThemes'

afterEach(() => window.localStorage.clear())

describe('registries', () => {
  it('ship the signed-off closed sets with the documented defaults', () => {
    expect(TERMINAL_THEMES.map((t) => t.id)).toEqual([
      'canvas',
      'midnight',
      'solarized',
      'dracula',
      'solarized-light'
    ])
    expect(DEFAULT_TERMINAL_THEME_ID).toBe('canvas')
    expect(TERMINAL_FONT_FAMILIES.map((f) => f.id)).toEqual(['system', 'geist', 'courier'])
    expect(DEFAULT_TERMINAL_FONT_FAMILY_ID).toBe('system')
  })

  it('keeps the Canvas default byte-identical to the pre-feature palette (existing boards unchanged)', () => {
    const canvas = terminalThemeColors('canvas')
    expect(canvas.background).toBe('#0e0e10')
    expect(canvas.foreground).toBe('#ededee')
    expect(canvas.cursor).toBe('#4f8cff')
    expect(canvas.blue).toBe('#4f8cff')
    expect(canvas.selectionBackground).toBe('rgba(79,140,255,0.25)')
  })
})

describe('terminalThemeColors — degrade unknown/absent to default (forward-compat)', () => {
  it('returns a known theme verbatim', () => {
    expect(terminalThemeColors('dracula').background).toBe('#282a36')
  })
  it('degrades an UNKNOWN id to the Canvas default', () => {
    expect(terminalThemeColors('some-future-theme')).toBe(terminalThemeColors('canvas'))
  })
  it('degrades an ABSENT id to the Canvas default', () => {
    expect(terminalThemeColors(undefined)).toBe(terminalThemeColors('canvas'))
  })
})

describe('resolveTerminalFontFamily — literal stack, degrade to system', () => {
  // jsdom loads no CSS, so the --term-mono* vars are unset and the literal fallback is returned.
  it('resolves a known id to its literal stack', () => {
    expect(resolveTerminalFontFamily('geist')).toContain('Geist Mono')
    expect(resolveTerminalFontFamily('courier')).toContain('Courier New')
  })
  it('degrades unknown/absent to the system default stack', () => {
    const system = resolveTerminalFontFamily('system')
    expect(resolveTerminalFontFamily('nope-future-font')).toBe(system)
    expect(resolveTerminalFontFamily(undefined)).toBe(system)
    expect(system).toContain('Cascadia Mono')
  })
})

describe('sticky last-used defaults', () => {
  it('reads the default when unset', () => {
    expect(readStickyThemeId()).toBe('canvas')
    expect(readStickyFontFamilyId()).toBe('system')
  })
  it('round-trips a known id', () => {
    writeStickyThemeId('dracula')
    expect(readStickyThemeId()).toBe('dracula')
    writeStickyFontFamilyId('courier')
    expect(readStickyFontFamilyId()).toBe('courier')
  })
  it('ignores an unknown id on write and on read', () => {
    writeStickyThemeId('bogus')
    expect(readStickyThemeId()).toBe('canvas') // write was a no-op
    window.localStorage.setItem('ca.terminal.themeId', 'bogus') // simulate a future id on disk
    expect(readStickyThemeId()).toBe('canvas') // read degrades to default
  })
})

describe('resolveInitialThemeId / resolveInitialFontFamilyId', () => {
  it('uses the board pin when present and known', () => {
    writeStickyThemeId('midnight')
    expect(resolveInitialThemeId('dracula')).toBe('dracula')
    writeStickyFontFamilyId('geist')
    expect(resolveInitialFontFamilyId('courier')).toBe('courier')
  })
  it('falls back to the sticky last-used when the pin is absent', () => {
    writeStickyThemeId('solarized')
    expect(resolveInitialThemeId(undefined)).toBe('solarized')
    writeStickyFontFamilyId('geist')
    expect(resolveInitialFontFamilyId(undefined)).toBe('geist')
  })
  it('degrades a present-but-UNKNOWN pin to the hard default (not the sticky)', () => {
    writeStickyThemeId('midnight') // sticky differs from default
    expect(resolveInitialThemeId('future-theme')).toBe('canvas')
    writeStickyFontFamilyId('courier')
    expect(resolveInitialFontFamilyId('future-font')).toBe('system')
  })
})

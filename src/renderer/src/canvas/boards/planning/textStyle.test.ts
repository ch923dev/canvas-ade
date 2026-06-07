import { describe, it, expect } from 'vitest'
import {
  SIZE_PX,
  lineHeightFor,
  COLOR_EXPORT,
  TEXT_COLOR_TOKENS,
  TEXT_DEFAULTS,
  FAMILY_EXPORT,
  FONT_FAMILY_TOKENS,
  estimateTextWidth
} from './textStyle'
import { EXPORT_COLORS } from './exportColors'

describe('textStyle tokens', () => {
  it('M size + its line height match the pre-v6 hardcoded text (no visual regression)', () => {
    expect(SIZE_PX.M).toBe(13)
    expect(lineHeightFor(SIZE_PX.M)).toBe(18)
  })

  it('defaults are sans / M / left / default / not-bold', () => {
    expect(TEXT_DEFAULTS).toEqual({
      fontFamily: 'sans',
      fontSize: 'M',
      align: 'left',
      color: 'default',
      bold: false
    })
  })

  it('export color literals mirror the resolved design tokens (anti-drift, R7)', () => {
    expect(COLOR_EXPORT.default).toBe(EXPORT_COLORS.text)
    expect(COLOR_EXPORT.muted).toBe(EXPORT_COLORS.text2)
    expect(COLOR_EXPORT.faint).toBe(EXPORT_COLORS.text3)
    expect(COLOR_EXPORT.accent).toBe(EXPORT_COLORS.accent)
  })

  it('every color token has a hex export literal', () => {
    for (const t of TEXT_COLOR_TOKENS) expect(COLOR_EXPORT[t]).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('FAMILY_EXPORT values are portable literals (no CSS custom props) ending in a generic family', () => {
    // The live --ui stack (Geist webfont) can't resolve in a standalone SVG, so the
    // export families INTENTIONALLY differ from FAMILY_CSS — they must stay var()-free
    // and fall back to a generic family. (The docstring's anti-drift promise is for
    // colors; this shape-guard is the families' equivalent.)
    for (const t of FONT_FAMILY_TOKENS) {
      expect(FAMILY_EXPORT[t]).not.toContain('var(')
      expect(FAMILY_EXPORT[t]).toMatch(/(sans-serif|serif|monospace)$/)
    }
  })
})

describe('estimateTextWidth (SVG center/right anchor, no DOM at export time)', () => {
  it('grows with the longest line length and with font size', () => {
    expect(estimateTextWidth('ab', 13, 'sans')).toBeLessThan(
      estimateTextWidth('abcdefgh', 13, 'sans')
    )
    expect(estimateTextWidth('abcd', 13, 'sans')).toBeLessThan(
      estimateTextWidth('abcd', 26, 'sans')
    )
  })

  it('uses the longest line for multi-line text', () => {
    expect(estimateTextWidth('a\nabcdefgh\nbb', 13, 'sans')).toBe(
      estimateTextWidth('abcdefgh', 13, 'sans')
    )
  })

  it('floors at the min textarea width (40, mirrors FreeText scrollWidth floor)', () => {
    expect(estimateTextWidth('', 13, 'sans')).toBe(40)
    expect(estimateTextWidth('x', 11, 'sans')).toBe(40)
  })
})

import { describe, it, expect } from 'vitest'
import { SIZE_PX, lineHeightFor, COLOR_EXPORT, TEXT_COLOR_TOKENS, TEXT_DEFAULTS } from './textStyle'
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
})

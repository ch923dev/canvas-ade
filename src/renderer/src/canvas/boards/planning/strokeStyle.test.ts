import { describe, it, expect } from 'vitest'
import {
  STROKE_COLOR_TOKENS,
  STROKE_WIDTH_TOKENS,
  STROKE_COLOR_EXPORT,
  strokeColorCss,
  strokeColorExport,
  ARROW_WIDTH_PX,
  PEN_WIDTH_PX,
  arrowWidthPx,
  penWidthPx,
  clampOpacity,
  OPACITY_MIN,
  OPACITY_MAX,
  OPACITY_DEFAULT
} from './strokeStyle'
import { EXPORT_COLORS } from './exportColors'

describe('strokeStyle tokens', () => {
  it('export color literals mirror the resolved design tokens (anti-drift, R7)', () => {
    expect(STROKE_COLOR_EXPORT.white).toBe(EXPORT_COLORS.text)
    expect(STROKE_COLOR_EXPORT.accent).toBe(EXPORT_COLORS.accent)
    // green/amber are --ok/--warn (not in EXPORT_COLORS today); pin the literals so a token change is deliberate.
    expect(STROKE_COLOR_EXPORT.green).toBe('#3ecf8e')
    expect(STROKE_COLOR_EXPORT.amber).toBe('#e8b339')
  })

  it('every non-default color token has a hex export literal', () => {
    for (const t of STROKE_COLOR_TOKENS) {
      if (t === 'default') continue
      expect(STROKE_COLOR_EXPORT[t]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('CSS resolvers are var()-based; default/absent fall back to the per-kind legacy colour', () => {
    expect(strokeColorCss('accent', 'var(--border-strong)')).toBe('var(--accent)')
    // default + undefined both resolve to the caller-supplied per-kind legacy ink (byte-identical).
    expect(strokeColorCss('default', 'var(--border-strong)')).toBe('var(--border-strong)')
    expect(strokeColorCss(undefined, 'var(--text-2)')).toBe('var(--text-2)')
  })

  it('export resolver mirrors the CSS resolver semantics (default → per-kind literal)', () => {
    expect(strokeColorExport('green', EXPORT_COLORS.borderStrong)).toBe('#3ecf8e')
    expect(strokeColorExport('default', EXPORT_COLORS.borderStrong)).toBe(
      EXPORT_COLORS.borderStrong
    )
    expect(strokeColorExport(undefined, EXPORT_COLORS.text2)).toBe(EXPORT_COLORS.text2)
  })

  it('the `m` width token equals the legacy per-kind width (absent renders byte-identical)', () => {
    // arrow legacy stroke-width = 1.5 (WhiteboardSvg); pen legacy size = 4 (STROKE_OPTIONS.size).
    expect(ARROW_WIDTH_PX.m).toBe(1.5)
    expect(PEN_WIDTH_PX.m).toBe(4)
    expect(arrowWidthPx(undefined)).toBe(1.5)
    expect(penWidthPx(undefined)).toBe(4)
    // monotonic S < M < L for both kinds.
    for (const map of [ARROW_WIDTH_PX, PEN_WIDTH_PX]) {
      expect(map.s).toBeLessThan(map.m)
      expect(map.m).toBeLessThan(map.l)
    }
  })

  it('there are exactly 3 width tokens s/m/l', () => {
    expect([...STROKE_WIDTH_TOKENS]).toEqual(['s', 'm', 'l'])
  })

  it('clampOpacity floors at OPACITY_MIN and caps at OPACITY_MAX; non-finite → default', () => {
    expect(clampOpacity(0)).toBe(OPACITY_MIN)
    expect(clampOpacity(0.05)).toBe(OPACITY_MIN)
    expect(clampOpacity(0.5)).toBe(0.5)
    expect(clampOpacity(2)).toBe(OPACITY_MAX)
    expect(clampOpacity(Number.NaN)).toBe(OPACITY_DEFAULT)
    expect(OPACITY_MIN).toBe(0.1)
    expect(OPACITY_MAX).toBe(1)
    expect(OPACITY_DEFAULT).toBe(1)
  })
})

/**
 * Single source of truth for free-text typography tokens (schema v6). Owns the token
 * unions + their LIVE (CSS custom-prop) and EXPORT (literal, portable) representations
 * for family / size / color, plus weight, line-height, and SVG text-anchor. Both the
 * live board (FreeText) and the SVG export (whiteboardExport) read from here so the two
 * can never drift — the R7 lesson (exportColors.ts duplicating tints.ts). A parity test
 * pins the EXPORT literals to the resolved design tokens.
 *
 * Pure data — no React, no DOM. Safe in the node test env.
 */
export const FONT_FAMILY_TOKENS = ['sans', 'mono', 'serif'] as const
export const FONT_SIZE_TOKENS = ['S', 'M', 'L', 'XL'] as const
export const TEXT_ALIGN_TOKENS = ['left', 'center', 'right'] as const
export const TEXT_COLOR_TOKENS = ['default', 'muted', 'faint', 'accent'] as const

export type FontFamilyToken = (typeof FONT_FAMILY_TOKENS)[number]
export type FontSizeToken = (typeof FONT_SIZE_TOKENS)[number]
export type TextAlignToken = (typeof TEXT_ALIGN_TOKENS)[number]
export type TextColorToken = (typeof TEXT_COLOR_TOKENS)[number]

/** Defaults chosen so a v5 text element (no tokens) renders byte-identical to pre-v6. */
export const TEXT_DEFAULTS = {
  fontFamily: 'sans',
  fontSize: 'M',
  align: 'left',
  color: 'default',
  bold: false
} satisfies {
  fontFamily: FontFamilyToken
  fontSize: FontSizeToken
  align: TextAlignToken
  color: TextColorToken
  bold: boolean
}

/** Live family stack (CSS custom prop). */
export const FAMILY_CSS: Record<FontFamilyToken, string> = {
  sans: 'var(--ui)',
  mono: 'var(--term-mono)',
  serif: 'var(--serif)'
}
/** Export family stack (literal generic — an exported SVG has no CSS custom props). */
export const FAMILY_EXPORT: Record<FontFamilyToken, string> = {
  sans: 'system-ui, -apple-system, Segoe UI, sans-serif',
  mono: 'Cascadia Mono, Consolas, ui-monospace, monospace',
  serif: 'Georgia, "Times New Roman", serif'
}

/** Pixel size per token. M = 13 (the pre-v6 hardcoded size). */
export const SIZE_PX: Record<FontSizeToken, number> = { S: 11, M: 13, L: 18, XL: 26 }
/** Line height (px) for a px size: 1.38× → lineHeightFor(13) === 18 (matches pre-v6). */
export const lineHeightFor = (px: number): number => Math.round(px * 1.38)

/** Live color (CSS custom prop). */
export const COLOR_CSS: Record<TextColorToken, string> = {
  default: 'var(--text)',
  muted: 'var(--text-2)',
  faint: 'var(--text-3)',
  accent: 'var(--accent)'
}
/** Export color (literal hex; mirrors the index.css token block / EXPORT_COLORS). */
export const COLOR_EXPORT: Record<TextColorToken, string> = {
  default: '#ededee',
  muted: '#9b9ba1',
  faint: '#6a6a70',
  accent: '#4f8cff'
}

export const WEIGHT = { normal: 400, bold: 700 } as const

/** SVG text-anchor for an alignment token. */
export const ANCHOR: Record<TextAlignToken, 'start' | 'middle' | 'end'> = {
  left: 'start',
  center: 'middle',
  right: 'end'
}

/**
 * Single source of truth for free-text typography tokens (schema v7). Owns the token
 * unions + their LIVE (CSS custom-prop) and EXPORT (literal, portable) representations
 * for family / size / color, plus weight, line-height, and SVG text-anchor. Both the
 * live board (FreeText) and the SVG export (whiteboardExport) read from here so the two
 * can never drift — the R7 lesson (exportColors.ts duplicating tints.ts). The EXPORT
 * COLOR literals are parity-pinned to the resolved design tokens (textStyle.test.ts).
 * The EXPORT FAMILY literals INTENTIONALLY differ from the live `var(--…)` stacks — a
 * standalone SVG can't resolve a CSS custom prop or fetch the --ui webfont (Geist), so
 * they fall back to portable generic stacks; a shape-guard test keeps them var()-free.
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

/** Defaults chosen so a pre-typography text element (no tokens) renders byte-identical to pre-v7. */
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
  // Unquoted multi-word names (cf. sans `Segoe UI`, mono `Cascadia Mono`) — an embedded `"`
  // would terminate the SVG `font-family="…"` attribute early (whiteboardExport.ts:82).
  serif: 'Georgia, Times New Roman, serif'
}

/** Pixel size per token. M = 13 (the pre-typography hardcoded size). */
export const SIZE_PX: Record<FontSizeToken, number> = { S: 11, M: 13, L: 18, XL: 26 }
/** Line height (px) for a px size: 1.38× → lineHeightFor(13) === 18 (matches pre-typography). */
export const lineHeightFor = (px: number): number => Math.round(px * 1.38)

/**
 * Map an area-text drag HEIGHT (board px) to the nearest size token. Thresholds chosen
 * so a small box reads as body text and a tall box as a heading. Pinned by a unit test —
 * a change to the bands is deliberate. < 24 → S · < 40 → M · < 70 → L · ≥ 70 → XL.
 */
export function tokenFromHeight(boardPx: number): FontSizeToken {
  if (boardPx < 24) return 'S'
  if (boardPx < 40) return 'M'
  if (boardPx < 70) return 'L'
  return 'XL'
}

/** Minimum width (board px) for a text element — area-text wrap floor + mirrors FreeText's Math.max(40, scrollWidth). */
export const MIN_TEXT_WIDTH_PX = 40

/** Approx glyph advance (× font-size) per family — for the export-time width estimate. */
const CHAR_ADVANCE: Record<FontFamilyToken, number> = { sans: 0.52, mono: 0.6, serif: 0.5 }
/**
 * Rough rendered width (px) of a text element's longest line. There is NO DOM at SVG
 * export time, so center/right anchoring can't read the auto-sized textarea — it
 * approximates the box from glyph count × size × a per-family advance. Floored at 40 to
 * mirror FreeText's `Math.max(40, scrollWidth)`. Exact width is unknowable without DOM;
 * this keeps center/right text close to its on-board position (left stays exact).
 */
export function estimateTextWidth(text: string, px: number, family: FontFamilyToken): number {
  const longest = text.split('\n').reduce((m, l) => Math.max(m, l.length), 0)
  return Math.max(MIN_TEXT_WIDTH_PX, Math.round(longest * px * CHAR_ADVANCE[family]))
}

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

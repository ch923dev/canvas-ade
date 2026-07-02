/**
 * Single source of truth for the Planning vector-layer STROKE appearance tokens (schema v17, P4b).
 * Owns the stroke-colour + stroke-width token unions and their LIVE (CSS custom-prop) and EXPORT
 * (literal, portable) representations, plus the element-opacity bounds. Both the live board
 * (WhiteboardSvg) and the SVG export (whiteboardExport) read from here so the two can never drift —
 * the R7 lesson that first bit `exportColors.ts` duplicating `tints.ts`. Mirrors `textStyle.ts`.
 *
 * Stroke applies to the LINE kinds only — the arrow (an SVG stroked bezier) and the pen `stroke` (a
 * perfect-freehand FILLED outline). The two have DIFFERENT width semantics (an SVG `stroke-width` vs
 * the perfect-freehand `size`), so width is a per-kind px map (`ARROW_WIDTH_PX` / `PEN_WIDTH_PX`).
 * Colour is shared EXCEPT the `default` token, which resolves to each kind's pre-P4b ink colour so an
 * ABSENT `strokeColor` and an explicit `default` both render byte-identical to the legacy vectors.
 * Each `m` width token equals the legacy per-kind width for the same byte-identical reason.
 *
 * Pure data — no React, no DOM. Safe in the node test env.
 */
export const STROKE_COLOR_TOKENS = ['default', 'white', 'accent', 'green', 'amber'] as const
export const STROKE_WIDTH_TOKENS = ['s', 'm', 'l'] as const

export type StrokeColorToken = (typeof STROKE_COLOR_TOKENS)[number]
export type StrokeWidthToken = (typeof STROKE_WIDTH_TOKENS)[number]

/** The non-`default` stroke colours (the `default` token resolves per kind, see below). */
type ConcreteStrokeColor = Exclude<StrokeColorToken, 'default'>

/**
 * Element opacity bounds (P4b decision 4). Floor at 0.1 so an element can never become
 * invisible-and-unfindable on the canvas (it stays clickable/reselectable). Default 1.0 ⇒ an absent
 * `opacity` renders byte-identical to pre-P4b.
 */
export const OPACITY_MIN = 0.1
export const OPACITY_MAX = 1
export const OPACITY_DEFAULT = 1

/** Clamp an opacity into [OPACITY_MIN, OPACITY_MAX]; a non-finite value degrades to the default. */
export function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return OPACITY_DEFAULT
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v))
}

/** Live stroke colour (CSS custom prop) for the non-`default` tokens. */
export const STROKE_COLOR_CSS: Record<ConcreteStrokeColor, string> = {
  white: 'var(--text)',
  accent: 'var(--accent)',
  green: 'var(--ok)',
  amber: 'var(--warn)'
}
/** Export stroke colour (literal hex; mirrors index.css / EXPORT_COLORS) for the non-`default` tokens. */
export const STROKE_COLOR_EXPORT: Record<ConcreteStrokeColor, string> = {
  white: '#ededee',
  accent: '#4f8cff',
  green: '#3ecf8e',
  amber: '#e8b339'
}

/**
 * Resolve a stroke-colour token to its LIVE value. `default` (and an absent/unknown token) falls back
 * to the caller's per-kind legacy colour (arrow → `--border-strong`, pen → `--text-2`), keeping an
 * absent `strokeColor` byte-identical to the pre-P4b ink.
 */
export function strokeColorCss(token: StrokeColorToken | undefined, kindDefault: string): string {
  if (token === undefined || token === 'default') return kindDefault
  return STROKE_COLOR_CSS[token] ?? kindDefault
}
/** Resolve a stroke-colour token to its EXPORT literal; `default`/absent → the caller's per-kind hex. */
export function strokeColorExport(
  token: StrokeColorToken | undefined,
  kindDefault: string
): string {
  if (token === undefined || token === 'default') return kindDefault
  return STROKE_COLOR_EXPORT[token] ?? kindDefault
}

/** Arrow SVG `stroke-width` (px) per token. `m` === the pre-P4b 1.5 ⇒ absent renders byte-identical. */
export const ARROW_WIDTH_PX: Record<StrokeWidthToken, number> = { s: 1, m: 1.5, l: 3 }
/**
 * Pen (perfect-freehand `size`) per token. `m` === STROKE_OPTIONS.size (4) ⇒ an absent `strokeWidth`
 * regenerates the identical outline. Feeds `strokeToPath(points, size)`.
 */
export const PEN_WIDTH_PX: Record<StrokeWidthToken, number> = { s: 2.5, m: 4, l: 7 }

/** Arrow legacy width px for an absent/`m` token — the resolver's default lookup key. */
export function arrowWidthPx(token: StrokeWidthToken | undefined): number {
  return ARROW_WIDTH_PX[token ?? 'm']
}
/** Pen legacy `size` px for an absent/`m` token. */
export function penWidthPx(token: StrokeWidthToken | undefined): number {
  return PEN_WIDTH_PX[token ?? 'm']
}

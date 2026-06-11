/**
 * Per-board terminal font size: bounds, clamp, and the global "sticky" last-used
 * default. Pure (the only side effect is localStorage, guarded). The TerminalBoard
 * persists the per-board pin in `board.fontSize`; the sticky default seeds the size
 * of the NEXT terminal so the user pays the "too big" adjustment once, not per board.
 * See docs/decisions/0005-terminal-font-size.md.
 */
export const DEFAULT_TERMINAL_FONT = 12.5
export const MIN_TERMINAL_FONT = 8
export const MAX_TERMINAL_FONT = 22

/** localStorage key for the global new-terminal default (per machine, all projects). */
const STICKY_KEY = 'ca.terminal.fontSize'

/** Clamp to [MIN, MAX]; non-finite input collapses to the default. */
export function clampTerminalFont(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_FONT
  return Math.min(MAX_TERMINAL_FONT, Math.max(MIN_TERMINAL_FONT, n))
}

/** Read the sticky default (clamped). Default on miss / parse-fail / no storage. */
export function readStickyFont(): number {
  try {
    const raw = window.localStorage.getItem(STICKY_KEY)
    if (raw == null) return DEFAULT_TERMINAL_FONT
    return clampTerminalFont(Number.parseFloat(raw))
  } catch {
    return DEFAULT_TERMINAL_FONT
  }
}

/** Persist the sticky default (clamped). No-op if storage is unavailable. */
export function writeStickyFont(n: number): void {
  try {
    window.localStorage.setItem(STICKY_KEY, String(clampTerminalFont(n)))
  } catch {
    /* storage disabled (private mode / test) — the sticky default just won't persist */
  }
}

/** Initial size for a board: its own pin if set, else the sticky default. */
export function resolveInitialFont(boardFontSize: number | undefined): number {
  return boardFontSize != null ? clampTerminalFont(boardFontSize) : readStickyFont()
}

/**
 * Effective RENDER font under the settled-zoom counter-scale (FREEZE re-raster):
 * pinned × counterScale, deliberately FRACTIONAL and deliberately UNCLAMPED — the
 * [MIN, MAX] bounds are pinned-space UX bounds, while proportionality is the FREEZE
 * invariant (grid px ≈ wrapper px at any zoom; clamping the effective value would
 * desync the grid from the counter-scaled wrapper). This value is ephemeral render
 * state: it is written ONLY to `term.options.fontSize`, NEVER to `board.fontSize` /
 * the store / undo (the fromObject clamp would destroy a persisted effective value).
 */
export function effectiveTerminalFont(pinned: number, counterScale: number): number {
  const cs = Number.isFinite(counterScale) && counterScale > 0 ? counterScale : 1
  return clampTerminalFont(pinned) * cs
}

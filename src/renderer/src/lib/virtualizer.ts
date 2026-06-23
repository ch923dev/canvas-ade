/**
 * Uniform-height list virtualizer (JD-2) — pure window math, no React/DOM (unit-tested like
 * `osrJson`). The JSON viewer renders single-line fixed-height rows, which makes `react-window`
 * unnecessary: from `scrollTop` + viewport height we compute the slice of rows to mount and the
 * top/bottom spacer heights that preserve the scrollbar geometry. Live DOM stays ~overscan-bounded
 * regardless of total row count.
 */

export interface WindowRange {
  /** First row index to render (inclusive). */
  start: number
  /** One past the last row index to render (exclusive). */
  end: number
  /** Spacer height above the rendered slice (= start · rowH). */
  padTop: number
  /** Spacer height below the rendered slice (= (total − end) · rowH). */
  padBottom: number
}

export interface WindowOpts {
  scrollTop: number
  viewportH: number
  rowH: number
  total: number
  /** Rows rendered beyond each edge so a fast scroll doesn't flash blank. Default 8. */
  overscan?: number
}

/**
 * The render window for the current scroll position. Clamped so `start`/`end` stay within
 * `[0, total]`; padBottom never goes negative. When the viewport hasn't been measured yet
 * (`viewportH <= 0`) we fall back to a small fixed count so the first paint shows something.
 */
export function windowRange(opts: WindowOpts): WindowRange {
  const { scrollTop, rowH, total } = opts
  const overscan = opts.overscan ?? 8
  if (total <= 0 || rowH <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }

  const viewportH = opts.viewportH > 0 ? opts.viewportH : rowH * 20
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rowH)
  const visibleCount = Math.ceil(viewportH / rowH)

  const start = Math.max(0, first - overscan)
  const end = Math.min(total, first + visibleCount + overscan)
  return {
    start,
    end,
    padTop: start * rowH,
    padBottom: Math.max(0, (total - end) * rowH)
  }
}

export interface ScrollIntoOpts {
  index: number
  scrollTop: number
  viewportH: number
  rowH: number
}

/**
 * The minimal new `scrollTop` that brings row `index` fully into view (nudges up if it's above the
 * fold, down if below, otherwise leaves scroll untouched). Used by keyboard nav + search-next so the
 * active/match row is always inside the render window — the invariant that keeps
 * `aria-activedescendant` pointing at a *mounted* element under virtualization.
 */
export function scrollToIndex(opts: ScrollIntoOpts): number {
  const { index, scrollTop, viewportH, rowH } = opts
  const top = index * rowH
  const bottom = top + rowH
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportH) return Math.max(0, bottom - viewportH)
  return scrollTop
}

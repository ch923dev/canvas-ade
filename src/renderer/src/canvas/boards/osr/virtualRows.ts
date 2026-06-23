/**
 * Table-preserving row virtualization for the Network inspector's request list (SLICE-010).
 *
 * The list is a REAL `<table>` (`table-layout: fixed`, CSS-fixed column widths, fixed-height rows).
 * We window it WITHOUT converting to a div-grid (the `react-window` route): that would risk the
 * "column layout + waterfall bars visually identical" invariant AND pull `react-window` in as an
 * undeclared dependency (it is only a transitive dep of `react-arborist`, and a worktree can't
 * `pnpm install` to declare it). Instead we render only the rows in the viewport (+overscan) between
 * two spacer `<tr>`s whose heights reserve the off-screen scroll extent — `<tr>`/`<td>` semantics and
 * the waterfall bars stay byte-identical, and at the 1000-record cap only ~viewport rows exist in the
 * DOM (the scalability-cliff fix).
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/** Matches `.bb-net-rows td { height: 26px }`; the hook re-measures the true pitch (incl. the
 *  collapsed 1px border) at runtime, so this is only the pre-measurement fallback. */
const ROW_H_FALLBACK = 26
/** Rows rendered beyond each viewport edge — covers fast/momentum scroll between re-window commits. */
const DEFAULT_OVERSCAN = 6

export interface RowWindow {
  /** First rendered row index (inclusive). */
  start: number
  /** One past the last rendered row index (exclusive). */
  end: number
  /** Px reserved above the window (the top spacer `<tr>` height). */
  topPad: number
  /** Px reserved below the window (the bottom spacer `<tr>` height). */
  bottomPad: number
}

/**
 * Pure window math (unit-tested). Renders `[start, end)` plus `overscan` rows beyond each edge.
 * Clamps `start` so a stale `scrollTop` left over from a now-shrunk list shows the LAST page rather
 * than a blank window. Using one `rowH` for both the index math and the spacer heights keeps the
 * rendered rows aligned with the native scroll offset.
 */
export function computeRowWindow(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan: number
): RowWindow {
  const rh = rowH > 0 ? rowH : ROW_H_FALLBACK
  const visible = Math.ceil(Math.max(0, viewportH) / rh) + overscan * 2
  const maxStart = Math.max(0, total - visible)
  const start = Math.min(Math.max(0, Math.floor(Math.max(0, scrollTop) / rh) - overscan), maxStart)
  const end = Math.min(total, start + visible)
  return { start, end, topPad: start * rh, bottomPad: Math.max(0, (total - end) * rh) }
}

/**
 * Track the scroll container's scroll position + viewport height and return the row window to render
 * for a list of `total` fixed-height rows. Scroll updates are rAF-coalesced (≤1 re-window per frame),
 * the viewport height is observed (dock switch / drag-resize), and the true row pitch is measured from
 * two live rows so the spacer heights match the real layout exactly (no scroll wobble).
 */
export function useVirtualRows(
  scrollRef: RefObject<HTMLElement | null>,
  total: number,
  enabled: boolean,
  overscan: number = DEFAULT_OVERSCAN
): RowWindow {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [rowH, setRowH] = useState(ROW_H_FALLBACK)

  // `enabled` is in every dep list because the scroll host mounts LATER than this hook's first run:
  // the panel returns null until open, so `scrollRef.current` is null on the initial effect pass.
  // Re-running when `enabled` flips true is what actually attaches the listeners to the live node.

  // Viewport height: seed immediately, then track resizes (dock switch / drag-resize change it).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !enabled) return
    setViewportH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef, enabled])

  // Scroll position, coalesced to one state update per animation frame.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !enabled) return
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollRef, enabled])

  // Measure the true per-row pitch (cell height + the collapsed border) from two consecutive rows.
  // Constant once laid out; re-running as `total` grows is a harmless no-op. Falls back to 26px when
  // <2 rows exist or the list isn't laid out yet (a safe under-estimate — the window over-covers).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !enabled) return
    const rows = el.querySelectorAll('.bb-net-row')
    if (rows.length < 2) return
    const pitch = rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
    if (pitch > 0 && Math.abs(pitch - rowH) > 0.5) setRowH(pitch)
  }, [scrollRef, enabled, total, rowH])

  return computeRowWindow(scrollTop, viewportH, rowH, total, overscan)
}

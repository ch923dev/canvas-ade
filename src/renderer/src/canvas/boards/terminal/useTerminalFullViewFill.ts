/**
 * Full-view ROW-FILL (terminal-scrollback fix follow-up — docs/research/2026-06-23-terminal-scrollback-
 * reflow § A1 "rows-only resize is safe"). Pure A1 froze the in-canvas grid in full view and scaled the
 * FONT up to fill the modal. Two side effects of the font-only approach:
 *   1. the grid keeps its few in-canvas rows, so a large same-bg **letterbox gutter** is left below the
 *      text (the black dead-space users read as "the terminal doesn't fill full view"); and
 *   2. in a LONG session the agent's input prompt (the buffer bottom) can be parked mid-viewport /
 *      scrolled out — the reported "Claude input not visible in full view."
 *
 * This hook adds the report's blessed extension: a **rows-only** `term.resize(term.cols, rows)` in full
 * view. Columns NEVER change, so xterm's `_reflow` early-returns (`Buffer.ts` `_cols === newCols`) — no
 * lossy scrollback reflow, no truncation/duplication (the whole point of Pure A1 is preserved). The
 * font-scale seam in `useTerminalReraster` is left untouched; this only adds/removes rows so the
 * frozen-width grid fills the modal height and the prompt sits at the true bottom.
 *
 * ENTER: after the font seam has applied the full-view render font (measure a frame later — xterm
 * re-measures cell metrics off the font write), grow (or shrink, if the scaled font left fewer rows
 * fitting than in-canvas) `term.rows` to fill the modal well, then `scrollToBottom()` so the live
 * prompt is visible. EXIT: restore the EXACT in-canvas row count saved on enter — a deterministic
 * restore, never a re-fit, so it can never race the font transition back to pinned and let the shell
 * redraw over the bottom rows (the line-loss the shipped-A1 note warned about). cols are frozen on
 * both legs ⇒ no reflow either way.
 */
import { useContext, useEffect, useRef, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { BoardFullViewContext } from '../../fullViewContext'

/** The screen host's symmetric padding (terminalBoardStyles `screen` = 12px). Kept out of the grid so
 *  the fill leaves the same 12px breathing room top+bottom — clip-free, reads as padding not a gutter. */
const SCREEN_PAD_Y = 24

export function useTerminalFullViewFill(termRef: RefObject<Terminal | null>): void {
  const isFullView = useContext(BoardFullViewContext)
  // The in-canvas row count captured on full-view ENTER, restored verbatim on EXIT (never a re-fit).
  const savedRowsRef = useRef<number | null>(null)

  useEffect(() => {
    if (!termRef.current) return
    let raf = 0
    let tries = 0
    let lastCellH = -1
    const tick = (): void => {
      const t = termRef.current
      if (!t?.element) return
      const wellEl = t.element.closest('.nowheel') as HTMLElement | null
      const screenEl = t.element.querySelector('.xterm-screen') as HTMLElement | null
      if (!wellEl || !screenEl) return
      if (isFullView) {
        // Measure in LAYOUT space: `offsetHeight`/`clientHeight` are transform-INVARIANT, but
        // `getBoundingClientRect` is NOT — the modal's ~320ms open-STRETCH transform scales the
        // subtree down, so a rect-based cell height read mid-stretch is tiny and would massively
        // over-count rows (grid then clips). Poll until the per-cell height (offsetHeight / rows)
        // SETTLES — i.e. the font seam's full-view render font has landed — before the one-shot
        // resize. Bounded so a stuck layout can't loop forever.
        const cellH = screenEl.offsetHeight / Math.max(1, t.rows)
        if (!(cellH > 0) || cellH !== lastCellH) {
          if (tries < 12) {
            lastCellH = cellH
            tries += 1
            raf = requestAnimationFrame(tick)
          }
          return
        }
        const fillRows = Math.max(1, Math.floor((wellEl.clientHeight - SCREEN_PAD_Y) / cellH))
        if (savedRowsRef.current == null) savedRowsRef.current = t.rows // freeze the in-canvas count
        // Rows-only: cols unchanged ⇒ no reflow. Grows to fill (or shrinks when a big scaled font
        // fits fewer rows than in-canvas — also clip-free).
        if (fillRows !== t.rows) t.resize(t.cols, fillRows)
        t.scrollToBottom() // long session: keep the live prompt (buffer bottom) visible
      } else {
        // Exit: restore the exact in-canvas rows (deterministic — never a re-fit). cols never changed.
        const saved = savedRowsRef.current
        savedRowsRef.current = null
        if (saved != null && saved !== t.rows) t.resize(t.cols, saved)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isFullView, termRef])
}

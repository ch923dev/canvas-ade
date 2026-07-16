/**
 * Full-view prompt-visibility scroll (S3 residue of the old row-fill hook).
 *
 * History: Pure A1 froze the full-view grid and scaled the FONT to fill the modal; this hook
 * then grew rows-only so the frozen-width grid filled the modal height. S3 unfroze the grid —
 * `fitWhole` now refits cols AND rows to the modal through the lossless S2 backstop — so the
 * fill/restore resize logic here became obsolete (the fit owns the grid on both legs of the
 * toggle). What remains is the one UX behavior the fit does not provide: once the full-view
 * grid settles, scroll to the buffer bottom so a long session's live prompt (the agent input)
 * is visible instead of parked mid-scrollback.
 *
 * Settle detection: poll until the per-cell height (offsetHeight / rows — transform-INVARIANT,
 * so the modal's ~320ms open-stretch cannot skew it) stops changing, i.e. the font seam's
 * full-view render font has landed and the backstop refit has applied its grid. Bounded; on
 * exhaustion it scrolls anyway (prompt visibility beats precision).
 *
 * @param refillKey re-run when this changes while IN full view — the host passes counterScale,
 * so a mid-full-view OS fullscreen/maximize (live fvWinSize → new scale → font re-apply →
 * backstop refit) re-runs the settle+scroll at the new grid.
 */
import { useContext, useEffect, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { BoardFullViewContext } from '../../fullViewContext'

export function useTerminalFullViewFill(
  termRef: RefObject<Terminal | null>,
  refillKey?: number
): void {
  const isFullView = useContext(BoardFullViewContext)

  useEffect(() => {
    if (!isFullView || !termRef.current) return undefined
    let raf = 0
    let tries = 0
    let lastCellH = -1
    const tick = (): void => {
      const t = termRef.current
      if (!t?.element) return
      const screenEl = t.element.querySelector('.xterm-screen') as HTMLElement | null
      if (!screenEl) return
      const cellH = screenEl.offsetHeight / Math.max(1, t.rows)
      if ((!(cellH > 0) || cellH !== lastCellH) && tries < 12) {
        lastCellH = cellH
        tries += 1
        raf = requestAnimationFrame(tick)
        return
      }
      t.scrollToBottom() // settled (or bounded out): keep the live prompt visible
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isFullView, termRef, refillKey])
}

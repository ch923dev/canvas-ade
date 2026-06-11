/**
 * Host-side wiring of the settled-zoom native re-raster (FREEZE variant) — see
 * docs/research/2026-06-12-terminal-native-reraster-audit.md and the counterScale
 * source in useTerminalSpawn. Two responsibilities, moved as a unit out of
 * TerminalBoard (max-lines ratchet):
 *
 *  1. The counter-scale wrapper style for the xterm host: layout at
 *     `boardContent × cs` with `transform: scale(1/cs)` — net visual scale exactly 1
 *     at rest (camera z === cs), so the renderer's backing store maps 1:1 to device
 *     pixels at every settled zoom. The padding scales WITH cs so the visual gutter
 *     matches the camera-scaled 12px it always had AND fit results stay z-invariant
 *     (available px and cell px scale by the same factor).
 *
 *  2. The SINGLE font seam — the ONLY writer of `term.options.fontSize` after
 *     construction (the audit's "two masters" rule). Two inputs, one writer: the
 *     persisted PIN (board.fontSize ?? bornFont — pinned-space, what undo /
 *     persistence / the toolbar see) and the settled-zoom counterScale. Effective
 *     render font = pinned × counterScale, fractional, never routed through
 *     updateBoard/undo. A PIN change reflows the grid (fitWhole → PTY resize, as
 *     before); a ZOOM-driven change never does — cols/rows are frozen across zoom,
 *     the wrapper and the font scale together. useLayoutEffect so the font lands in
 *     the same paint as the wrapper style (no one-frame glyph-size flash on settle).
 *     Plus the NO-CLIP correction: xterm cell dims quantize to whole px, so the frozen
 *     grid can land one cell-step wider/taller than the wrapper at some zooms — a
 *     bounded rAF loop steps the render font down until the grid fits (gutter, never
 *     clipped TUI content).
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MutableRefObject,
  type RefObject
} from 'react'
import type { Terminal } from '@xterm/xterm'
import { clampTerminalFont, effectiveTerminalFont } from './terminalFont'

export interface TerminalRerasterDeps {
  /** The persisted per-board pin (board.fontSize) — undefined ⇒ unpinned. */
  pinnedFontSize: number | undefined
  /** The font this board was born with (frozen at mount) — the unpinned fallback. */
  bornFont: number
  /** Settled-zoom counter-scale factor from useTerminalSpawn (1 in full view). */
  counterScale: number
  termRef: RefObject<Terminal | null>
  fitWhole: () => void
  /** The host's authoritative pinned-font ref (nudges step from it) — synced here. */
  liveFontRef: MutableRefObject<number>
  /** The identity (cs = 1) layout style for the xterm host. */
  identityStyle: CSSProperties
}

/** Returns the style for the xterm host div (identity at cs = 1). */
export function useTerminalReraster(deps: TerminalRerasterDeps): CSSProperties {
  const { pinnedFontSize, bornFont, counterScale, termRef, fitWhole, liveFontRef, identityStyle } =
    deps

  const prevPinRef = useRef<number>(clampTerminalFont(pinnedFontSize ?? bornFont))
  // Monotonic token: each seam run supersedes any older no-clip correction loop, so a
  // stale rAF chain from a previous settle can never fight the current one.
  const correctTokenRef = useRef(0)
  useLayoutEffect(() => {
    // Unpinned board falls back to the BORN font (frozen at mount), not the live sticky — a live
    // sticky would have drifted under this board's own nudges and so undo-to-unpinned would not
    // revert. Sync the authoritative ref FIRST (even before the term mounts) so a nudge after an
    // external change (undo / project load) steps from the truth.
    const fs = clampTerminalFont(pinnedFontSize ?? bornFont)
    liveFontRef.current = fs
    const pinChanged = prevPinRef.current !== fs
    prevPinRef.current = fs
    const term = termRef.current
    if (!term) return
    const effective = effectiveTerminalFont(fs, counterScale)
    if (term.options.fontSize !== effective) term.options.fontSize = effective
    // A bigger PIN means taller cells -> the row count must drop; whole-cell fit keeps it
    // clip-free. (Unfitted well: fitWhole swallows the not-laid-out throw; next RO fit
    // applies.) Zoom-driven effective changes skip this — FREEZE.
    if (pinChanged) fitWhole()

    // No-clip correction. xterm quantizes cell dims to WHOLE px (letterSpacing and
    // lineHeight quantize too — measured, see the research doc §quantization), so the
    // frozen cols×rows grid at eff = pin×cs can land one integer cell-step WIDER/TALLER
    // than the counter-scaled wrapper — the right/bottom edge would clip live TUI
    // content. Step the render font down (multiplicative, bounded) until the grid fits;
    // the cost is tiny (one cell-step ≈ 0.25px of font) and the residual UNDERFILL is a
    // same-background gutter that reads as padding. Measured a frame later — xterm
    // re-measures cell metrics off the options write — and re-checked per step. At
    // cs = 1 the grid was fitted by fitWhole, so the loop no-ops (zero 100% regression).
    const token = ++correctTokenRef.current
    const stepDown = (tries: number): void => {
      requestAnimationFrame(() => {
        if (token !== correctTokenRef.current) return // superseded by a newer seam run
        const t = termRef.current
        const screenEl = t?.element?.querySelector('.xterm-screen')
        const wellEl = t?.element?.closest('.nowheel')
        if (!t || !screenEl || !wellEl) return
        const g = screenEl.getBoundingClientRect()
        const w = wellEl.getBoundingClientRect()
        if (g.width === 0 || (g.right <= w.right + 0.5 && g.bottom <= w.bottom + 0.5)) return
        // Budget exhausted with residual overflow: stop SILENTLY by design — the measured
        // worst case needs ONE step (a single integer cell-step), so four ×0.97 steps
        // (~11.5% of font) is already past any reachable geometry; an unbounded loop
        // risks oscillation if cell metrics misreport mid-layout.
        if (tries <= 0) return
        t.options.fontSize = (t.options.fontSize ?? effective) * 0.97
        stepDown(tries - 1)
      })
    }
    stepDown(4)
    // Cleanup: bump the token so any in-flight rAF chain from THIS run dies on unmount /
    // re-run (the in-callback guards already make it side-effect-free; this makes the
    // cancellation explicit instead of relying on them).
    return () => {
      // Monotonic counter ref, not a DOM node: cancellation MUST mutate the live value at
      // cleanup time (a captured copy would defeat the rAF callbacks' supersede check).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      correctTokenRef.current++
    }
    // termRef/fitWhole/liveFontRef are stable (refs + a []-useCallback from useTerminalSpawn);
    // listed because exhaustive-deps no longer treats destructured hook refs as stable (#98).
  }, [pinnedFontSize, bornFont, counterScale, fitWhole, termRef, liveFontRef])

  return useMemo<CSSProperties>(
    () =>
      counterScale === 1
        ? identityStyle
        : {
            position: 'absolute',
            left: 0,
            top: 0,
            width: `${counterScale * 100}%`,
            height: `${counterScale * 100}%`,
            transform: `scale(${1 / counterScale})`,
            transformOrigin: '0 0',
            padding: 12 * counterScale
          },
    [counterScale, identityStyle]
  )
}

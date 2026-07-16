/**
 * Host-side font seam + full-view scale-up for the xterm terminal (terminal-crisp umbrella,
 * docs/research/2026-06-25-terminal-dom-renderer). Two responsibilities, moved as a unit out
 * of TerminalBoard (max-lines ratchet):
 *
 *  1. The host layout style. The live terminal runs on xterm's DOM renderer, which Chromium
 *     re-rasters crisp at the live camera scale — so IN-CANVAS the host is IDENTITY and rides
 *     the camera transform directly (counterScale is 1). There is no counter-scale wrapper
 *     in-canvas; the `scale(1/cs)` branch survives only as defense for a hypothetical non-1
 *     in-canvas counterScale and is unreachable today (full view also returns identity — below).
 *
 *  2. The SINGLE font seam — the ONLY writer of `term.options.fontSize` after construction
 *     (the "two masters" rule). Two inputs, one writer: the persisted PIN (board.fontSize ??
 *     bornFont — pinned-space, what undo / persistence / the toolbar see) and `counterScale`.
 *     Effective render font = pinned × counterScale. In-canvas counterScale is 1, so the render
 *     font is just the pin (constant across zoom — the DOM renderer handles crispness). In FULL
 *     VIEW counterScale is the modal-FILL factor (fullViewScale, Pure A1 #235): the board is
 *     portaled OUTSIDE React Flow with no camera, so the grid is enlarged by the render font
 *     (pinned × fullViewScale) and — since S3 — REFIT to the modal at that font through the
 *     lossless S2 backstop (a cols change no longer corrupts scrollback; spare width becomes
 *     columns). A PIN change refits immediately; a counterScale change refits one frame later.
 *     useLayoutEffect so the font lands in the same paint as the host style.
 *     Plus the NO-CLIP correction (full-view safety net): xterm cell dims quantize to whole px,
 *     so the frozen grid at pinned × fullViewScale can land one cell-step wider/taller than the
 *     modal — a bounded rAF loop steps the render font down until it fits. At counterScale = 1
 *     (in-canvas) the grid was fitted by fitWhole, so the loop no-ops.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MutableRefObject,
  type RefObject
} from 'react'
import type { Terminal } from '@xterm/xterm'
import { clampTerminalFont, effectiveTerminalFont } from './terminalFont'
import { BoardFullViewContext } from '../../fullViewContext'

export interface TerminalRerasterDeps {
  /** The persisted per-board pin (board.fontSize) — undefined ⇒ unpinned. */
  pinnedFontSize: number | undefined
  /** The font this board was born with (frozen at mount) — the unpinned fallback. */
  bornFont: number
  /** Scale factor from useTerminalSpawn: 1 in-canvas (DOM renderer, no counter-scale), or the
   *  modal-FILL factor in full view (fullViewScale, Pure A1 #235). Drives the render font. */
  counterScale: number
  termRef: RefObject<Terminal | null>
  fitWhole: () => void
  /** The host's authoritative pinned-font ref (nudges step from it) — synced here. */
  liveFontRef: MutableRefObject<number>
  /** The identity (cs = 1) layout style for the xterm host. */
  identityStyle: CSSProperties
}

/** Returns the host layout style (identity today) + drives the single font seam. */
export function useTerminalReraster(deps: TerminalRerasterDeps): CSSProperties {
  const { pinnedFontSize, bornFont, counterScale, termRef, fitWhole, liveFontRef, identityStyle } =
    deps
  // Read full-view directly off context (this hook runs in the board's render tree, under
  // BoardFullViewContext.Provider) so the host doesn't have to thread the flag through. In full
  // view the scale-up is the bigger render font ALONE (no camera to compensate), so the wrapper
  // must stay IDENTITY — the in-canvas `transform: scale(1/cs)` would shrink the grid by 1/cs.
  const isFullView = useContext(BoardFullViewContext)

  // A-Polish (terminal-scrollback fix): force ONE full repaint after a full-view TOGGLE. Pure A1
  // already removes the reflow (cols frozen), but the toggle still re-measures cells (font flips
  // pinned↔pinned×fill-factor) across the portal relocation, during which xterm's renderer can be
  // paused — so the font-change repaint may be deferred/dropped, leaving stale rows (the reported
  // "duplication"). A post-relocation rAF + term.refresh paints the frozen grid cleanly. Cheap
  // (one repaint per toggle), and a no-op when no term is mounted.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const t = termRef.current
      if (t) t.refresh(0, t.rows - 1)
    })
    return () => cancelAnimationFrame(id)
  }, [isFullView, termRef])

  const prevPinRef = useRef<number>(clampTerminalFont(pinnedFontSize ?? bornFont))
  // S3 unfreeze: the previous counterScale, so a cs change (full-view enter/exit, the live
  // mid-full-view fullscreen rescale) can trigger its own DEFERRED refit — see below.
  const prevCsRef = useRef(1)
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
    // applies.)
    if (pinChanged) fitWhole()
    // S3 unfreeze: a counterScale change (full-view enter/exit, live fullscreen rescale) also
    // refits — the grid is no longer frozen; fitWhole routes the cols change through the
    // lossless S2 backstop. Deferred ONE FRAME (unlike the pin path): xterm re-measures cell
    // metrics off the options.fontSize write asynchronously, so an immediate propose would use
    // the OLD cell size. The portal resize's own RO fit may still land first with stale
    // metrics — the backstop's in-flight gate coalesces the two into sequential fits that
    // converge on the final grid.
    const csChanged = prevCsRef.current !== counterScale
    prevCsRef.current = counterScale
    const refitRaf = csChanged && !pinChanged ? requestAnimationFrame(() => fitWhole()) : 0

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
      // A superseded cs-refit must not fire under the NEXT seam run's just-written font
      // (the re-run schedules its own; fitWhole itself stays idempotent either way).
      if (refitRaf) cancelAnimationFrame(refitRaf)
    }
    // termRef/fitWhole/liveFontRef are stable (refs + a []-useCallback from useTerminalSpawn);
    // listed because exhaustive-deps no longer treats destructured hook refs as stable (#98).
  }, [pinnedFontSize, bornFont, counterScale, fitWhole, termRef, liveFontRef])

  return useMemo<CSSProperties>(
    () =>
      // Identity in BOTH live cases: in-canvas cs === 1 (the DOM renderer rides the camera, no
      // counter-scale), and full view (the scale-up is the bigger render font — no camera; an
      // in-canvas `scale(1/cs)` would shrink the grid — and the S3 backstop refit fills the
      // modal with real columns/rows at that font). The `scale(1/cs)` branch below is retained
      // as defense but unreachable today.
      isFullView || counterScale === 1
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
    [isFullView, counterScale, identityStyle]
  )
}

/**
 * Full-view modal: a fullscreen overlay over a 66%-black scrim with an accent-ringed
 * frame and a portal host that the matching board relocates its live content into. The
 * relocated board keeps its own title bar, whose full-view toggle icon flips to "Exit
 * full view" — that toggle is the in-frame exit affordance (USER DECISION 2026-06-01:
 * no separate top band). Does NOT move the camera. Closes on the board's title-bar
 * toggle, Esc, or a scrim click. Renders the host immediately and publishes it on mount
 * so the BoardNode can portal into it the same frame.
 *
 * Motion — "stretch" (CRISP transform FLIP from larger, USER DECISION 2026-06-20): the
 * frame sits at the full-view rect (5vh/5vw inset) from the start, so its relocated content
 * lays out + rasterises at FULL resolution (xterm refits, OSR resizes). It then animates a
 * CSS `transform` from [scaled + translated onto the origin board's on-screen rect] → to
 * identity, with an overshoot spring — the board visibly stretches out of its spot on open
 * and stretches back into it on close. Because the full-res content is only ever scaled
 * DOWN to ≤ native during the tween, raster boards (terminal/browser) stay crisp the whole
 * stretch (the earlier geometry-grow up-scaled a small bitmap → blur; this never does — only
 * a hair of softness can show at the overshoot peak, momentarily > native, then settles). The
 * scrim opacity-fades alongside. Transform is applied IMPERATIVELY (not via the style prop)
 * so a re-render mid-animation can't reset it; a useLayoutEffect seeds the start transform
 * before first paint so there's no flash. On `closing` the parent keeps `fullViewId` set
 * until `onExited` fires, so the live subtree stays relocated through the stretch (clearing
 * it earlier would tear the session). Lifecycle callbacks are timer-driven (not
 * `transitionend`, which never fires under reduced-motion); reduced-motion snaps to identity
 * with no tween (CSS also forces `transition: none !important`) and collapses the timers.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { CAMERA_MS, EASE_OVERSHOOT_CSS, FULLVIEW_MS, prefersReducedMotion } from '../lib/motion'

/** Screen-space rectangle (client px) the full-view frame stretches between. */
export interface FullViewRect {
  left: number
  top: number
  width: number
  height: number
}

// D0-9: the "Esc to exit" hint shows on the FIRST full-view entry per app session
// (module flag, deliberately not persisted — a gentle once-per-launch reminder, and
// e2e runs stay deterministic with no sticky localStorage to reset).
let escHintShown = false
const ESC_HINT_HOLD_MS = 3000

// The centred full-view rect = the scrim's 5vh/5vw inset, in client px. The frame lives
// here (full geometry) so its content rasterises at full res; the stretch is a transform.
function viewportFullRect(): FullViewRect {
  const padX = window.innerWidth * 0.05
  const padY = window.innerHeight * 0.05
  return {
    left: padX,
    top: padY,
    width: window.innerWidth - padX * 2,
    height: window.innerHeight - padY * 2
  }
}
function applyRect(el: HTMLElement, r: FullViewRect): void {
  el.style.left = `${r.left}px`
  el.style.top = `${r.top}px`
  el.style.width = `${r.width}px`
  el.style.height = `${r.height}px`
}
/** Transform that visually places the full-size frame onto rect `r` (origin top-left): a
 *  down-scale + translate, so the full-res content is only ever shrunk (crisp), never blown
 *  up past native. */
function rectToTransform(full: FullViewRect, r: FullViewRect): string {
  const sx = r.width / full.width
  const sy = r.height / full.height
  const tx = r.left - full.left
  const ty = r.top - full.top
  return `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`
}
const transformTransition = (): string => `transform ${FULLVIEW_MS}ms ${EASE_OVERSHOOT_CSS}`

export function FullViewModal({
  closing,
  onClose,
  onEntered,
  onExited,
  onHost,
  getOriginRect
}: {
  /** Parent requests the exit animation; the modal plays it then calls onExited. */
  closing: boolean
  /** A user-initiated close (Esc or scrim click; the title-bar toggle also routes
   *  here) — parent starts the exit. */
  onClose: () => void
  /** Enter tween settled — parent drops `entering`. */
  onEntered: () => void
  /** Exit tween settled — parent clears `fullViewId` (unmounts + relocates back). */
  onExited: () => void
  onHost: (el: HTMLElement | null) => void
  /** The origin board's CURRENT on-screen rect (client px) for the stretch FLIP, or null
   *  if it can't be resolved (then the frame just appears at the full rect). Read live so
   *  the close stretch targets the board's real spot even after a window resize. */
  getOriginRect: () => FullViewRect | null
}): ReactElement {
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Captured once at mount: where the board sits on screen, so the open stretch starts
  // from the board's rect (and we know whether a stretch is even possible).
  const [originRect] = useState<FullViewRect | null>(() => getOriginRect())
  // D0-9: mount the hint only on the session's first entry; `show` drives the fade
  // (in with the scrim, out after the hold), then the element unmounts.
  const [hint, setHint] = useState(() => !escHintShown)
  const [hintShow, setHintShow] = useState(false)

  useEffect(() => {
    if (!hint) return
    escHintShown = true
    const raf = requestAnimationFrame(() => setHintShow(true))
    // Hold, then fade out; unmount after the fade so the exit transition can play.
    // Reduced-motion: transitions are off (CSS), the timers just show/remove it.
    const fade = setTimeout(() => setHintShow(false), ESC_HINT_HOLD_MS)
    const gone = setTimeout(
      () => setHint(false),
      ESC_HINT_HOLD_MS + (prefersReducedMotion() ? 0 : CAMERA_MS) + 16
    )
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(fade)
      clearTimeout(gone)
    }
  }, [hint])

  useEffect(() => {
    onHost(hostEl)
    return () => onHost(null)
  }, [hostEl, onHost])

  // Seed BEFORE first paint (no flash): the frame at the FULL rect (content rasterises full
  // res) but visually transformed onto the board's rect, ready to stretch to identity.
  // Imperative so a later re-render never overrides it.
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    el.style.transition = 'none'
    applyRect(el, viewportFullRect())
    el.style.transform =
      originRect && !prefersReducedMotion()
        ? rectToTransform(viewportFullRect(), originRect)
        : 'none'
  }, [originRect])

  // Enter: next frame, stretch the transform to identity (full) + fade the scrim in.
  useEffect(() => {
    const reduced = prefersReducedMotion()
    const el = frameRef.current
    const raf = requestAnimationFrame(() => {
      setOpen(true)
      if (el) {
        el.style.transition = originRect && !reduced ? transformTransition() : 'none'
        el.style.transform = 'none'
      }
    })
    const t = setTimeout(onEntered, (reduced ? 0 : FULLVIEW_MS) + 16)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [onEntered, originRect])

  // Exit: stretch the transform back onto the board's CURRENT rect, then onExited unmounts +
  // relocates the live subtree back to canvas.
  useEffect(() => {
    if (!closing) return
    const reduced = prefersReducedMotion()
    const el = frameRef.current
    const back = getOriginRect()
    const raf = requestAnimationFrame(() => {
      setOpen(false)
      if (el && back && !reduced) {
        el.style.transition = transformTransition()
        el.style.transform = rectToTransform(viewportFullRect(), back)
      }
    })
    const t = setTimeout(onExited, (reduced ? 0 : FULLVIEW_MS) + 16)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [closing, onExited, getOriginRect])

  // Mid-full-view window resize → keep the frame filling the new viewport (full geometry;
  // transform stays identity while open, so no tween needed).
  useEffect(() => {
    function onResize(): void {
      const el = frameRef.current
      if (el && !closing) {
        el.style.transition = 'none'
        applyRect(el, viewportFullRect())
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [closing])

  return (
    <div
      className="fullview-scrim"
      data-open={open ? '' : undefined}
      onMouseDown={(e) => {
        // Only a click on the scrim itself (not the frame) closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="fullview-frame" ref={frameRef} onMouseDown={(e) => e.stopPropagation()}>
        <div className="fullview-host" ref={setHostEl} />
      </div>
      {/* D0-9: transient exit hint — the three exit paths (Esc / title-bar toggle /
          scrim click) are otherwise unlabeled. pointer-events:none (CSS), so it never
          eats a scrim click. */}
      {hint && (
        <div className="fullview-hint" data-show={hintShow ? '' : undefined}>
          <kbd>Esc</kbd> to exit
        </div>
      )}
    </div>
  )
}

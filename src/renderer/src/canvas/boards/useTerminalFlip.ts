/**
 * Flip controller for the Terminal board's terminal⇄recap flip (⟳ button + double-click).
 *
 * A two-phase 3D "fold" that SETTLES FLAT: the stage folds the current face away
 * (rotateY 0→90°, edge-on), swaps the visible face at the invisible 90° edge, then
 * unfolds the new face (rotateY −90°→0°). At rest the stage carries NO transform and the
 * parent NO perspective. That flat-at-rest invariant is the whole point: a *persistent*
 * `preserve-3d`/back-face structure is what made Chromium mis-map pointer hit-testing and
 * left the recap's refresh button unclickable. Here 3D exists only mid-animation, and we
 * never rotate past 90° so no mirrored back-face is ever shown.
 *
 * The xterm well is OUTSIDE this hook — it stays mounted across the flip (the PTY never
 * tears down); this hook only drives the rotation + which face is "up" (`flipped`).
 *
 * `prefers-reduced-motion` collapses the fold to an instant face swap (DESIGN.md §9).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { prefersReducedMotion } from '../../lib/motion'

/** Duration of ONE fold half (out OR in) in ms — a full flip is two halves. */
export const FLIP_HALF_MS = 150
/** Mirrors motion.ts EASE_STANDARD (cubic-bezier(.2,.7,.2,1)) as a CSS string. */
const FLIP_EASE = 'cubic-bezier(.2,.7,.2,1)'

export type FlipPhase = 'idle' | 'out' | 'in'

export interface TerminalFlip {
  /** Which face is up. Swaps at the 90° edge mid-fold (or instantly under reduced motion). */
  flipped: boolean
  phase: FlipPhase
  /** Inline style for the rotating stage wrapper — flat (no transform) at rest. */
  stageStyle: CSSProperties
  /** Inline style for the perspective parent — perspective only while folding. */
  perspectiveStyle: CSSProperties
  /** Toggle the flip. Animates unless reduced-motion; ignored while a fold is in flight. */
  toggle: () => void
}

export function useTerminalFlip(initial = false): TerminalFlip {
  const [flipped, setFlipped] = useState(initial)
  const [phase, setPhase] = useState<FlipPhase>('idle')
  const [rotation, setRotation] = useState(0)
  // false only for the instant −90° re-arm so the unfold animates from the edge, not jumps.
  const [animated, setAnimated] = useState(true)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const rafs = useRef<number[]>([])

  // Cancel any in-flight fold on unmount so a removed board can't fire setState after teardown.
  useEffect(() => {
    const t = timers.current
    const r = rafs.current
    return () => {
      t.forEach(clearTimeout)
      r.forEach((id) => cancelAnimationFrame(id))
    }
  }, [])

  const toggle = useCallback(() => {
    // Re-entrancy guard: a mid-fold toggle must not cancel a swap or double-flip.
    if (phase !== 'idle') return

    if (prefersReducedMotion()) {
      setFlipped((v) => !v)
      return
    }

    // Phase OUT: the current face folds away, 0 → 90° (edge-on, invisible at the end).
    setPhase('out')
    setAnimated(true)
    setRotation(90)

    const t1 = setTimeout(() => {
      // At the 90° edge: swap the face and RE-ARM the rotation to −90° with NO transition,
      // so the unfold starts from the far edge instead of snapping across.
      setFlipped((v) => !v)
      setAnimated(false)
      setRotation(-90)
      setPhase('in')

      // Two rAFs: frame 1 lets the no-transition −90° commit/paint; frame 2 re-enables the
      // transition and unfolds −90° → 0°. One rAF can batch with the commit and skip the tween.
      const r1 = requestAnimationFrame(() => {
        const r2 = requestAnimationFrame(() => {
          setAnimated(true)
          setRotation(0)
        })
        rafs.current.push(r2)
      })
      rafs.current.push(r1)

      // Settle: drop back to flat/idle once the unfold has run.
      const t2 = setTimeout(() => {
        setPhase('idle')
        setRotation(0)
      }, FLIP_HALF_MS)
      timers.current.push(t2)
    }, FLIP_HALF_MS)
    timers.current.push(t1)
  }, [phase])

  const animating = phase !== 'idle'
  const stageStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    ...(animating
      ? {
          transform: `rotateY(${rotation}deg)`,
          transition: animated ? `transform ${FLIP_HALF_MS}ms ${FLIP_EASE}` : 'none',
          willChange: 'transform',
          // We never cross 90°, but hide any sub-pixel back-face during the fold anyway.
          backfaceVisibility: 'hidden'
        }
      : {})
  }
  const perspectiveStyle: CSSProperties = animating ? { perspective: '1200px' } : {}

  return { flipped, phase, stageStyle, perspectiveStyle, toggle }
}

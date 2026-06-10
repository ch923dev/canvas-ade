/**
 * D2-D: lingering presence for the LOD-boundary crossfade (design audit fix 3).
 *
 * Returns true while `active`, and for `ms` after it falls, so the leaving layer
 * stays mounted long enough to fade out (CSS `ca-lod-fade-out`) over the already-
 * mounted entering layer. Rising edges are instant — the entering layer mounts
 * immediately and fades in via CSS, so the crossfade never delays anything that
 * keys on the raw flag (preview detach/reattach stays on `isLod` — ADR 0002;
 * this hook is a visual-only layer).
 *
 * Under prefers-reduced-motion the linger collapses and presence mirrors `active`
 * exactly (§9: animated ops become instant). Read at the falling edge so a runtime
 * preference change is honored.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../lib/motion'

/** LOD crossfade duration (ms) — keep in sync with the ca-lod-fade-* keyframes (§9). */
export const LOD_FADE_MS = 100

export function useLingeringPresence(active: boolean, ms: number = LOD_FADE_MS): boolean {
  const [lingering, setLingering] = useState(false)
  const prev = useRef(active)
  // `ms` lives in a ref (synced every render, read at timer-arm time) so it is NOT an
  // effect dep: with it in the dep array, an ms change mid-linger re-ran the effect —
  // cleanup cancelled the in-flight timer and the edge guard below early-returned
  // without re-arming, leaving `lingering` stuck true until the next active edge.
  // Declared before the edge effect so this sync runs first each commit.
  const msRef = useRef(ms)
  useLayoutEffect(() => {
    msRef.current = ms
  })
  // useLayoutEffect, NOT useEffect: a passive effect fires after paint, so the
  // falling edge would render one frame with `active || lingering` both false —
  // unmounting the leaving layer (blank flash + remount churn) before the linger
  // kicks in. The layout effect commits `lingering = true` synchronously before
  // paint, so presence never dips on the falling edge. Electron-only (no SSR).
  useLayoutEffect(() => {
    if (prev.current === active) return undefined
    prev.current = active
    if (active) {
      // Rising edge: cancel any in-flight linger (rapid re-cross of the threshold)
      // so the layer doesn't carry a stale fade-out timer back into presence.
      // Edge-triggered timer state — it can't be derived during render (the timer
      // arm/cancel must pair with it), so the sync set is intentional here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLingering(false)
      return undefined
    }
    if (prefersReducedMotion()) return undefined
    setLingering(true)
    const t = window.setTimeout(() => setLingering(false), msRef.current)
    return () => window.clearTimeout(t)
  }, [active])
  return active || lingering
}

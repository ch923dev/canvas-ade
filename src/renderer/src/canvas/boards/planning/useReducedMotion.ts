import { useEffect, useState } from 'react'

/**
 * Live `prefers-reduced-motion` (S4b). The diagram render resolves motion at RENDER time because
 * media queries do not re-evaluate inside an SVG displayed via `<img>` — the mode is baked into
 * the render (diagramTheme.diagramMotionSentinel) and a preference flip re-renders via effect deps.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

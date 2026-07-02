import type { KeyboardEvent } from 'react'

/** Roving-tabindex arrow-key handler for a radiogroup (P5 a11y — the ARIA radio pattern:
 *  ONE tab stop, arrows move focus AND select). DOM-driven: reads the group's radios off the
 *  container at keydown time, so it works for the primitive segmented/swatch rows and the
 *  Planning tool grid alike (no per-item refs). Wraps at both ends. Own module (not
 *  primitives.tsx) so that file keeps component-only exports for Fast Refresh. */
export function inspectorRadioGroupKeyDown(
  e: KeyboardEvent<HTMLDivElement>,
  onIndex: (i: number) => void
): void {
  const dir =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? -1
        : 0
  if (dir === 0) return
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')
  )
  const at = radios.indexOf(e.target as HTMLButtonElement)
  if (at < 0 || radios.length < 2) return
  e.preventDefault()
  const next = (at + dir + radios.length) % radios.length
  radios[next].focus()
  onIndex(next)
}

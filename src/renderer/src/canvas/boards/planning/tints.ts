/**
 * Sticky-note tint palette for the Planning whiteboard (DESIGN.md §7.3: "4 muted
 * note tints at low chroma"). Each tint pairs a fill with a slightly stronger
 * edge so notes read as paper on the dark `--surface`, not as flat chips. Values
 * are ported verbatim from `design-reference/project/boards.jsx` `Note` (the
 * authoritative markup); `plain` falls back to the raised-surface tokens.
 *
 * Pure data (no React) so it can be shared by the editor + any future renderer.
 */
import type { NoteTint } from '../../../lib/boardSchema'

export interface TintStyle {
  /** Note background fill. */
  fill: string
  /** Note border colour (a touch stronger than the fill). */
  edge: string
}

/** Fill + edge per note tint. Low-chroma so one accent stays the only colour. */
export const NOTE_TINTS: Record<NoteTint, TintStyle> = {
  yellow: { fill: '#2a2818', edge: '#3d3a22' },
  blue: { fill: '#16202b', edge: '#22354a' },
  green: { fill: '#16241d', edge: '#21392c' },
  plain: { fill: 'var(--surface-raised)', edge: 'var(--border)' }
}

/** Tint cycle order used when spawning successive notes (visual variety). */
export const TINT_CYCLE: NoteTint[] = ['yellow', 'blue', 'green', 'plain']

/** A small deterministic rotation (deg) for a freshly-dropped note, by index. */
export function noteRotation(index: number): number {
  // ±1.2° alternating — matches the gentle tilt in the design reference.
  const mag = [1, -1.2, 0.8, -0.9]
  return mag[index % mag.length]
}

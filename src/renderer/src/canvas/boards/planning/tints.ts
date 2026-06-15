/**
 * Sticky-note tint palette for the Planning whiteboard (DESIGN.md §7.3: "4 muted
 * note tints at low chroma"). Each tint pairs a fill with a slightly stronger
 * edge so notes read as paper on the dark `--surface`, not as flat chips.
 *
 * Colours are NAMED CSS tokens (`--note-*` in `index.css`); this module references
 * them via `var(--…)` so the palette has a single source of truth (the concrete hex
 * — ported originally from `design-reference/project/boards.jsx` `Note` — lives there).
 * `plain` falls back to the raised-surface tokens. These `var()` strings resolve only
 * in a DOM style context (NoteCard / ElementContextMenu inline styles); the standalone
 * SVG-export path can't read custom properties, so it keeps its own concrete mirror in
 * `exportColors.ts` (`EXPORT_NOTE_TINTS`) — keep the two in step.
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

/** Fill + edge per note tint. Low-chroma so one accent stays the only colour.
 *  Values are `--note-*` CSS tokens (index.css) — resolved at render in the DOM. */
export const NOTE_TINTS: Record<NoteTint, TintStyle> = {
  yellow: { fill: 'var(--note-yellow-fill)', edge: 'var(--note-yellow-edge)' },
  blue: { fill: 'var(--note-blue-fill)', edge: 'var(--note-blue-edge)' },
  green: { fill: 'var(--note-green-fill)', edge: 'var(--note-green-edge)' },
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

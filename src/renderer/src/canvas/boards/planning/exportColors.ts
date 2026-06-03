/**
 * Concrete colour values for the whiteboard SVG export. An exported standalone SVG
 * has no access to the app's CSS custom properties, so every `var(--…)` the live
 * board uses must be resolved to a literal here. Values mirror src/renderer/src/index.css
 * (§ token block) — keep them in step if the palette changes.
 */
export const EXPORT_COLORS = {
  void: '#0a0a0b',
  surface: '#141416',
  surfaceRaised: '#1a1a1d',
  inset: '#0e0e10',
  borderSubtle: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.1)',
  borderStrong: 'rgba(255,255,255,0.16)',
  text: '#ededee',
  text2: '#9b9ba1',
  text3: '#6a6a70',
  textFaint: '#46464b',
  accent: '#4f8cff'
} as const

/** Note tint fills/edges (tints.ts NOTE_TINTS with `plain` resolved to concrete tokens). */
export const EXPORT_NOTE_TINTS: Record<'yellow' | 'blue' | 'green' | 'plain', { fill: string; edge: string }> = {
  yellow: { fill: '#2a2818', edge: '#3d3a22' },
  blue: { fill: '#16202b', edge: '#22354a' },
  green: { fill: '#16241d', edge: '#21392c' },
  plain: { fill: EXPORT_COLORS.surfaceRaised, edge: EXPORT_COLORS.border }
}

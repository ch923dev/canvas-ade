/**
 * DiagramSpec theming bridge (v21, diagram-viz Phase 1) — sibling of `diagramTheme.ts` for the
 * `engine:'expanse'` renderer. Pure, no React: maps the closed spec vocabularies to app design
 * tokens read LIVE off `:root`, so dark/light and future restyles flow through automatically and
 * the "single accent / neutral elsewhere" contract stays unit-testable.
 *
 * Doctrine encoded (B8 + the approved Phase-1 design artifact, docs/research/2026-07-19-…/phase1-design):
 *  - STATUS = wash fill + half-strength status-hue border + GLYPH — colour is never the only
 *    carrier (B1); the SAME wash+half-border recipe as the Phase-0 Mermaid palette so both engines
 *    read as one system.
 *  - The one saturated accent appears on `active` ONLY (nodes) and on `animated` edge flow.
 *  - KIND = a 13px line icon + a calm silhouette tweak (decision = clipped corners, actor = pill,
 *    note = dashed); step/data/service/artifact share the base rect and differ by icon alone.
 */
import { withAlpha } from './diagramTheme'
import type { SpecEdge, SpecNodeKind, SpecStatus } from '../../../lib/diagramSpec'

/** Resolve a CSS custom property off :root (same discipline as diagramTheme.token). */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * Per-status glyph — ships WITH the colour, never instead of a label (B1: status = icon + label,
 * never colour alone). `neutral` carries no glyph: no colour claim, nothing to disambiguate.
 */
export const SPEC_STATUS_GLYPHS: Record<SpecStatus, string> = {
  neutral: '',
  active: '●',
  done: '✓',
  error: '✕',
  warn: '!',
  muted: '–'
}

export interface SpecStatusStyle {
  /** Node fill (status wash, or the raised surface for neutral/muted). */
  fill: string
  /** Node border (half-strength status hue, or the neutral border). */
  border: string
  /** Status glyph character ('' for neutral). */
  glyph: string
  /** Glyph ink (full-strength status hue). */
  glyphColor: string
  /** Whole-node opacity (muted's 0.55; 1 otherwise). */
  opacity: number
}

/** status → colours+glyph, tokens read live. The wash/half-border numbers mirror
 *  `buildDiagramThemeCss` exactly — the two engines must stay one palette (risk R7). */
export function specStatusStyle(status: SpecStatus | undefined): SpecStatusStyle {
  const s: SpecStatus = status ?? 'neutral'
  const raised = token('--surface-raised', '#1a1a1d')
  const border = token('--border', 'rgba(255,255,255,0.1)')
  const text3 = token('--text-3', '#7b7b81')
  const base: SpecStatusStyle = {
    fill: raised,
    border,
    glyph: SPEC_STATUS_GLYPHS[s],
    glyphColor: text3,
    opacity: 1
  }
  switch (s) {
    case 'neutral':
      return base
    case 'muted':
      return { ...base, opacity: 0.55 }
    case 'active': {
      const accent = token('--accent', '#4f8cff')
      return {
        ...base,
        fill: token('--accent-wash', 'rgba(79, 140, 255, 0.14)'),
        border: accent, // full-strength: active is THE emphasis and the only saturated border
        glyphColor: accent
      }
    }
    case 'done': {
      const ok = token('--ok', '#3ecf8e')
      return {
        ...base,
        fill: token('--ok-wash', 'rgba(62, 207, 142, 0.14)'),
        border: withAlpha(ok, 0.5),
        glyphColor: ok
      }
    }
    case 'warn': {
      const warn = token('--warn', '#e8b339')
      return {
        ...base,
        fill: token('--warn-wash', 'rgba(232, 179, 57, 0.12)'),
        border: withAlpha(warn, 0.5),
        glyphColor: warn
      }
    }
    case 'error': {
      const err = token('--err', '#f2545b')
      return {
        ...base,
        fill: token('--err-wash', 'rgba(242, 84, 91, 0.14)'),
        border: withAlpha(err, 0.55),
        glyphColor: err
      }
    }
  }
}

/** Calm silhouette per kind — the base rect unless the kind earns a quiet variation. */
export type SpecSilhouette = 'rect' | 'decision' | 'actor' | 'note'

export function specKindSilhouette(kind: SpecNodeKind | undefined): SpecSilhouette {
  switch (kind) {
    case 'decision':
      return 'decision'
    case 'actor':
      return 'actor'
    case 'note':
      return 'note'
    default:
      return 'rect'
  }
}

/**
 * 24-viewBox stroke paths for the per-kind mark (13px, `currentColor`, 1.5 stroke — the Icon.tsx
 * chrome discipline, drawn per the approved mock). `note` carries none: its dashed silhouette IS
 * the mark. These are spec-renderer-local on purpose — the chrome Icon registry stays functional
 * UI marks; a node's optional `icon` field is what indexes into that registry.
 */
export const SPEC_KIND_PATHS: Record<SpecNodeKind, string[]> = {
  step: ['M4 7h16M4 12h16M4 17h10'],
  decision: ['M12 3 L21 12 L12 21 L3 12 Z'],
  data: ['M20 6a8 3 0 1 1-16 0a8 3 0 1 1 16 0', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6'],
  service: [
    'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    'M9 9h6v6H9z'
  ],
  artifact: ['M21 8 L12 3 L3 8 v8 l9 5 9-5 z', 'M3 8 l9 5 9-5', 'M12 13 v8'],
  actor: ['M16 8a4 4 0 1 1-8 0a4 4 0 0 1 8 0', 'M4 21c0-4 4-6 8-6s8 2 8 6'],
  note: []
}

export interface SpecGroupStyle {
  /** Cluster border ink (dashed) — half-strength status hue, accent for active, neutral default. */
  border: string
  /** Cluster fill — a 4% status wash (quieter than the node wash: chrome, not content). */
  background: string
  /** Group label ink. */
  label: string
}

/** group status → cluster chrome (the Phase-1 silent gap: `SpecGroup.status` was validated but
 *  never rendered). Same wash + half-border recipe as nodes, at chrome strength. */
export function specGroupStyle(status: SpecStatus | undefined): SpecGroupStyle {
  const neutral: SpecGroupStyle = {
    border: token('--border-strong', 'rgba(255,255,255,0.16)'),
    background: 'rgba(255,255,255,0.015)',
    label: token('--text-3', '#7b7b81')
  }
  switch (status ?? 'neutral') {
    case 'active': {
      const accent = token('--accent', '#4f8cff')
      return { border: accent, background: withAlpha(accent, 0.04), label: accent }
    }
    case 'done': {
      const ok = token('--ok', '#3ecf8e')
      return { border: withAlpha(ok, 0.5), background: withAlpha(ok, 0.04), label: ok }
    }
    case 'warn': {
      const warn = token('--warn', '#e8b339')
      return { border: withAlpha(warn, 0.5), background: withAlpha(warn, 0.04), label: warn }
    }
    case 'error': {
      const err = token('--err', '#f2545b')
      return { border: withAlpha(err, 0.55), background: withAlpha(err, 0.04), label: err }
    }
    case 'muted':
      return { ...neutral, label: token('--text-faint', '#46464b') }
    default:
      return neutral
  }
}

export interface SpecEdgeStyle {
  /** Stroke ink — border-strong neutral, a half-strength status hue, or the accent when animated. */
  stroke: string
  /** SVG dash pattern ('' = solid). */
  dasharray: string
  /** True ⇒ the renderer attaches the marching-dash keyframe class (reduced-motion gates it). */
  animated: boolean
}

/** edge {kind, status, animated} → line style. Animated wins the stroke (accent flow, the Phase-0
 *  edge-flow look); otherwise status tints at half strength; otherwise neutral border-strong ink. */
export function specEdgeStyle(edge: Pick<SpecEdge, 'kind' | 'status' | 'animated'>): SpecEdgeStyle {
  const animated = edge.animated === true
  const kindDash = edge.kind === 'dependency' ? '3 4' : edge.kind === 'data' ? '1.5 3.5' : ''
  if (animated) {
    // The Phase-0 Mermaid edge-flow recipe: accent 6/5 dash (diagramTheme.buildDiagramThemeCss).
    return { stroke: token('--accent', '#4f8cff'), dasharray: '6 5', animated: true }
  }
  let stroke = token('--border-strong', 'rgba(255,255,255,0.16)')
  if (edge.status && edge.status !== 'neutral' && edge.status !== 'muted') {
    const hue = {
      active: token('--accent', '#4f8cff'),
      done: token('--ok', '#3ecf8e'),
      warn: token('--warn', '#e8b339'),
      error: token('--err', '#f2545b')
    }[edge.status]
    stroke = withAlpha(hue, 0.5)
  }
  return { stroke, dasharray: kindDash, animated: false }
}

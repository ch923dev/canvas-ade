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
import type { CSSProperties } from 'react'
import { withAlpha } from './diagramTheme'
import type { SpecEdge, SpecNodeKind, SpecStatus } from '../../../lib/diagramSpec'

/** Resolve a CSS custom property off :root (same discipline as diagramTheme.token). */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * B6 theme presets (Phase 2) — per the approved phase2-design mock:
 *  - `calm`     the default recipe below, unchanged;
 *  - `graphite` monochrome statuses: done/warn/error re-ink onto the text greys with faint white
 *               washes — the glyph SHAPE carries status (B1 holds); the ONE accent (`active` +
 *               animated flow) stays saturated (B8 taken to its extreme);
 *  - `signal`   boosted washes (0.22) + full-strength status borders for wall-view legibility.
 * `DiagramSpec.theme` is an OPEN string: an unknown preset renders as `calm` and the value is
 * preserved (presentation-only fallback — unlike status/kind, nothing is lost by not knowing it).
 */
export const SPEC_THEME_PRESETS = ['calm', 'graphite', 'signal'] as const
export type SpecThemePreset = (typeof SPEC_THEME_PRESETS)[number]

export function specThemePreset(theme: string | undefined): SpecThemePreset {
  return (SPEC_THEME_PRESETS as readonly string[]).includes(theme ?? '')
    ? (theme as SpecThemePreset)
    : 'calm'
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

/** status → colours+glyph, tokens read live. The calm wash/half-border numbers mirror
 *  `buildDiagramThemeCss` exactly — the two engines must stay one palette (risk R7); the
 *  graphite/signal deltas mirror the approved phase2-design mock's scoped var overrides. */
export function specStatusStyle(
  status: SpecStatus | undefined,
  preset: SpecThemePreset = 'calm'
): SpecStatusStyle {
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
      const fill =
        preset === 'graphite'
          ? 'rgba(255, 255, 255, 0.07)'
          : preset === 'signal'
            ? withAlpha(accent, 0.22)
            : token('--accent-wash', 'rgba(79, 140, 255, 0.14)')
      return {
        ...base,
        fill,
        border: accent, // full-strength: active is THE emphasis — every preset keeps the one accent
        glyphColor: accent
      }
    }
    case 'done': {
      if (preset === 'graphite') {
        const ink = token('--text-2', '#b8b8be')
        return {
          ...base,
          fill: 'rgba(255, 255, 255, 0.05)',
          border: token('--border-strong', 'rgba(255,255,255,0.16)'),
          glyphColor: ink
        }
      }
      const ok = token('--ok', '#3ecf8e')
      if (preset === 'signal') {
        return { ...base, fill: withAlpha(ok, 0.22), border: ok, glyphColor: ok }
      }
      return {
        ...base,
        fill: token('--ok-wash', 'rgba(62, 207, 142, 0.14)'),
        border: withAlpha(ok, 0.5),
        glyphColor: ok
      }
    }
    case 'warn': {
      if (preset === 'graphite') {
        const ink = token('--text-2', '#b8b8be')
        return {
          ...base,
          fill: 'rgba(255, 255, 255, 0.04)',
          border: token('--border-strong', 'rgba(255,255,255,0.16)'),
          glyphColor: ink
        }
      }
      const warn = token('--warn', '#e8b339')
      if (preset === 'signal') {
        return { ...base, fill: withAlpha(warn, 0.2), border: warn, glyphColor: warn }
      }
      return {
        ...base,
        fill: token('--warn-wash', 'rgba(232, 179, 57, 0.12)'),
        border: withAlpha(warn, 0.5),
        glyphColor: warn
      }
    }
    case 'error': {
      if (preset === 'graphite') {
        const ink = token('--text', '#ededee')
        return {
          ...base,
          fill: 'rgba(255, 255, 255, 0.06)',
          border: withAlpha(ink, 0.4),
          glyphColor: ink
        }
      }
      const err = token('--err', '#f2545b')
      if (preset === 'signal') {
        return { ...base, fill: withAlpha(err, 0.22), border: err, glyphColor: err }
      }
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

/** Decision silhouette: clipped corners (the approved mock's calm octagon). */
export const DECISION_CLIP =
  'polygon(9px 0, calc(100% - 9px) 0, 100% 9px, 100% calc(100% - 9px), ' +
  'calc(100% - 9px) 100%, 9px 100%, 0 calc(100% - 9px), 0 9px)'

/**
 * Silhouette + status → a node div's CHROME (background/border/radius/clip/padding + opacity).
 * Positioning/sizing is the caller's job — the static `DiagramSpecView` adds absolute left/top/w/h;
 * the Phase-4 editor's React Flow node is positioned by RF and sized from the layout box. Shared so
 * the two renderers can never drift (risk R7).
 */
export function specNodeChrome(sil: SpecSilhouette, status: SpecStatusStyle): CSSProperties {
  const style: CSSProperties = {
    boxSizing: 'border-box',
    background: sil === 'note' ? 'var(--surface)' : status.fill,
    border: `1px ${sil === 'note' ? 'dashed' : 'solid'} ${status.border}`,
    borderRadius: sil === 'actor' ? 'var(--r-pill)' : 'var(--r-inner)',
    opacity: status.opacity,
    padding: sil === 'actor' ? '7px 9px 7px 12px' : '7px 9px 7px 8px'
  }
  if (sil === 'decision') {
    style.clipPath = DECISION_CLIP
    style.borderRadius = 0
  }
  return style
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
 *  never rendered). Same wash + half-border recipe as nodes, at chrome strength; presets follow
 *  the node deltas — graphite re-inks onto the greys, signal goes full-hue border. */
export function specGroupStyle(
  status: SpecStatus | undefined,
  preset: SpecThemePreset = 'calm'
): SpecGroupStyle {
  const neutral: SpecGroupStyle = {
    border: token('--border-strong', 'rgba(255,255,255,0.16)'),
    background: 'rgba(255,255,255,0.015)',
    label: token('--text-3', '#7b7b81')
  }
  const hued = (hue: string, borderAlpha: number): SpecGroupStyle => {
    if (preset === 'signal') {
      return { border: hue, background: withAlpha(hue, 0.06), label: hue }
    }
    return {
      border: withAlpha(hue, borderAlpha),
      background: withAlpha(hue, 0.04),
      label: hue
    }
  }
  switch (status ?? 'neutral') {
    case 'active': {
      const accent = token('--accent', '#4f8cff')
      // Every preset keeps the one accent full-strength (B8) — signal only lifts the wash.
      return {
        border: accent,
        background: withAlpha(accent, preset === 'signal' ? 0.06 : 0.04),
        label: accent
      }
    }
    case 'done':
      return preset === 'graphite'
        ? { ...neutral, label: token('--text-2', '#b8b8be') }
        : hued(token('--ok', '#3ecf8e'), 0.5)
    case 'warn':
      return preset === 'graphite'
        ? { ...neutral, label: token('--text-2', '#b8b8be') }
        : hued(token('--warn', '#e8b339'), 0.5)
    case 'error': {
      if (preset === 'graphite') {
        const ink = token('--text', '#ededee')
        return { border: withAlpha(ink, 0.4), background: neutral.background, label: ink }
      }
      return hued(token('--err', '#f2545b'), 0.55)
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
 *  edge-flow look); otherwise status tints at half strength; otherwise neutral border-strong ink.
 *  Graphite re-inks the status tints onto the greys (accent flow stays); signal keeps calm's. */
export function specEdgeStyle(
  edge: Pick<SpecEdge, 'kind' | 'status' | 'animated'>,
  preset: SpecThemePreset = 'calm'
): SpecEdgeStyle {
  const animated = edge.animated === true
  const kindDash = edge.kind === 'dependency' ? '3 4' : edge.kind === 'data' ? '1.5 3.5' : ''
  if (animated) {
    // The Phase-0 Mermaid edge-flow recipe: accent 6/5 dash (diagramTheme.buildDiagramThemeCss).
    return { stroke: token('--accent', '#4f8cff'), dasharray: '6 5', animated: true }
  }
  let stroke = token('--border-strong', 'rgba(255,255,255,0.16)')
  if (edge.status && edge.status !== 'neutral' && edge.status !== 'muted') {
    const hue =
      preset === 'graphite'
        ? {
            active: token('--accent', '#4f8cff'), // the one accent survives graphite
            done: token('--text-2', '#b8b8be'),
            warn: token('--text-2', '#b8b8be'),
            error: token('--text', '#ededee')
          }[edge.status]
        : {
            active: token('--accent', '#4f8cff'),
            done: token('--ok', '#3ecf8e'),
            warn: token('--warn', '#e8b339'),
            error: token('--err', '#f2545b')
          }[edge.status]
    stroke = withAlpha(hue, 0.5)
  }
  return { stroke, dasharray: kindDash, animated: false }
}

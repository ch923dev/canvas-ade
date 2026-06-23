/**
 * Diagram theming + dialect helpers (S4) — pure, no React, so the "single accent / neutral
 * elsewhere" contract is unit-testable and reusable (DiagramCard today; a future MCP-emit path).
 */

/** Resolve a CSS custom property off :root (the board renders inside the app document). */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * Map the app design tokens → Mermaid `theme:'base'` themeVariables: neutral surfaces, ONE accent
 * (active/selected only), Geist — NO rainbow/gradient/glow (the default Mermaid palette violates the
 * no-slop contract). Read from CSS so a future theme change flows through automatically.
 */
export function buildDiagramThemeVars(): Record<string, string> {
  const surface = token('--surface', '#141416')
  const raised = token('--surface-raised', '#1a1a1d')
  const overlay = token('--surface-overlay', '#1e1e22')
  const text = token('--text', '#ededee')
  const line = token('--border-strong', 'rgba(255,255,255,0.16)')
  const accent = token('--accent', '#4f8cff')
  return {
    background: surface,
    mainBkg: raised,
    primaryColor: raised,
    primaryTextColor: text,
    primaryBorderColor: line,
    secondaryColor: overlay,
    secondaryBorderColor: line,
    secondaryTextColor: text,
    tertiaryColor: surface,
    tertiaryBorderColor: line,
    tertiaryTextColor: text,
    lineColor: line,
    textColor: text,
    nodeBorder: line,
    clusterBkg: surface,
    clusterBorder: line,
    titleColor: text,
    edgeLabelBackground: surface,
    labelBoxBkgColor: surface,
    actorBkg: raised,
    actorBorder: line,
    actorTextColor: text,
    // erDiagram attribute rows default to WHITE / light-gray in Mermaid even under a dark base theme,
    // so our near-white text renders invisibly on them. Pin both to dark surfaces (a subtle zebra) so
    // the rows meet contrast. (a11y fix — the JD-4 ER export readability pass.)
    attributeBackgroundColorOdd: raised,
    attributeBackgroundColorEven: surface,
    // The one saturated colour, used only on active/selected accents Mermaid draws.
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    fontFamily: 'Geist, ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: '13px'
  }
}

/** A short human label for the diagram dialect, from the first meaningful source token. */
export function diagramTypeLabel(source: string): string {
  const head = source.trimStart().split(/\s|\n/, 1)[0]?.toLowerCase() ?? ''
  if (head === 'sequencediagram') return 'sequence'
  if (head === 'erdiagram') return 'ER'
  if (head === 'classdiagram') return 'class'
  if (head === 'statediagram' || head === 'statediagram-v2') return 'state'
  if (head === 'gantt') return 'gantt'
  if (head === 'flowchart' || head === 'graph') return 'flowchart'
  return 'diagram'
}

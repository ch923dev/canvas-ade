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
    // erDiagram attribute rows: the unified `erBox` shape renderer fills each row from `rowOdd` /
    // `rowEven` (NOT the legacy `attributeBackgroundColor*` CSS vars — those are dead for this
    // renderer). Mermaid's base-theme `rowOdd` default is `lighten(mainBkg, 75%)` ≈ near-white, so
    // our near-white attribute text renders INVISIBLY on the odd rows. Pin BOTH parities to dark
    // surfaces (a subtle zebra) so every row meets contrast. (a11y fix — JD-4 ER export pass; the
    // e2e `erDiagram attribute rows render on DARK surfaces` test locks this against a Mermaid bump.)
    rowOdd: raised,
    rowEven: surface,
    // Legacy alias for older Mermaid ER paths that still read these — kept in sync, harmless.
    attributeBackgroundColorOdd: raised,
    attributeBackgroundColorEven: surface,
    // The one saturated colour, used only on active/selected accents Mermaid draws.
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    fontFamily: 'Geist, ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: '13px'
  }
}

/**
 * Semantic status vocabulary agents (and users) attach via plain Mermaid classes — `A[Step]:::done`
 * in flowcharts, `class s1 done` in stateDiagram-v2. No `classDef` declaration is needed (probed on
 * the vendored 11.15 build: bare classes land on the node `<g>` unchanged); the styling comes from
 * {@link buildDiagramThemeCss}, so agents write MEANING and the host owns the colour.
 */
export const DIAGRAM_STATUS_CLASSES = ['done', 'active', 'warn', 'error', 'muted'] as const

/** `#rgb`/`#rrggbb` → `rgba(r, g, b, alpha)`. A non-hex input (an already-`rgba()` token) is
 *  returned unchanged — its alpha then comes from the token itself. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  let h = m[1]
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * Sentinel class name baked into every rendered SVG recording WHICH motion mode it was rendered
 * with. Needed because media queries do NOT re-evaluate inside an SVG displayed via `<img>` (the
 * image document is isolated — verified empirically), so `prefers-reduced-motion` must be resolved
 * at RENDER time and the derived cache invalidated on mismatch ({@link cacheMotionMatches}).
 */
export function diagramMotionSentinel(motion: boolean): string {
  return motion ? 'expanse-motion-on' : 'expanse-motion-off'
}

/** True when a cached SVG's baked motion mode matches the live preference. A pre-sentinel cache
 *  (neither marker present) reads as stale → one upgrade re-render, then it carries the marker. */
export function cacheMotionMatches(svgText: string, motion: boolean): boolean {
  return svgText.includes(diagramMotionSentinel(motion))
}

/**
 * Token-derived CSS injected via Mermaid `themeCSS` (S4b — semantic status theming + edge flow).
 *
 * Cascade contract (probed against the vendored 11.15 build, locked by e2e): Mermaid id-prefixes
 * every themeCSS rule (`#<renderId> .node.done …`) and appends the block AFTER its own generated
 * rules — equal specificity + later position means our declarations win, and `!important` is added
 * only where Mermaid's own rule is `!important` (the edge-animation `stroke-dasharray`).
 *
 * Status fills reuse the app's existing wash tokens (12–14% alpha) with a half-strength status-hue
 * border — the calm-palette contract: colour encodes state, the one saturated accent stays on
 * `active` only. Edge flow restyles Mermaid's OWN `edge-animation-fast/slow` classes (agents opt in
 * with the standard `e1@{ animate: true }` syntax) to a tighter accent dash march; with `motion`
 * false the same classes are forced static — the render is decided by the LIVE reduced-motion
 * preference at render time (see {@link diagramMotionSentinel}).
 */
export function buildDiagramThemeCss(motion: boolean): string {
  const accent = token('--accent', '#4f8cff')
  const accentWash = token('--accent-wash', 'rgba(79, 140, 255, 0.14)')
  const ok = token('--ok', '#3ecf8e')
  const okWash = token('--ok-wash', 'rgba(62, 207, 142, 0.14)')
  const warn = token('--warn', '#e8b339')
  const warnWash = token('--warn-wash', 'rgba(232, 179, 57, 0.12)')
  const err = token('--err', '#f2545b')
  const errWash = token('--err-wash', 'rgba(242, 84, 91, 0.14)')
  // Every fillable node shape Mermaid emits for flowchart/state nodes (rect · decision polygon ·
  // circle · stadium/subroutine paths). Labels stay on the neutral text colour deliberately.
  const shapes = (cls: string): string =>
    `.node.${cls} rect, .node.${cls} polygon, .node.${cls} circle, .node.${cls} path`
  const status = (cls: string, fill: string, stroke: string): string =>
    `${shapes(cls)} { fill: ${fill}; stroke: ${stroke}; }`
  const rules = [
    // Cache sentinel — must appear in every render (see diagramMotionSentinel).
    `.${diagramMotionSentinel(motion)} { opacity: 1; }`,
    status('done', okWash, withAlpha(ok, 0.5)),
    status('active', accentWash, accent),
    status('warn', warnWash, withAlpha(warn, 0.5)),
    status('error', errWash, withAlpha(err, 0.55)),
    `.node.muted { opacity: 0.55; }`,
    // Label weight aligns with the app's --fw-label (500) — typography pass, no size change.
    `.node .label text { font-weight: 500; }`
  ]
  if (motion) {
    rules.push(
      // Seamless loop: -22 = 2× the 6+5 dash period.
      `@keyframes expanse-flow { to { stroke-dashoffset: -22; } }`,
      `.edge-animation-fast { stroke: ${accent}; stroke-dasharray: 6, 5 !important; ` +
        `stroke-dashoffset: 0; animation: expanse-flow 0.9s linear infinite !important; }`,
      `.edge-animation-slow { stroke: ${accent}; stroke-dasharray: 6, 5 !important; ` +
        `stroke-dashoffset: 0; animation: expanse-flow 1.8s linear infinite !important; }`
    )
  } else {
    rules.push(
      // Reduced motion: the SAME opt-in classes render as calm solid strokes — no dash, no march.
      `.edge-animation-fast, .edge-animation-slow { animation: none !important; ` +
        `stroke-dasharray: 0 !important; stroke-dashoffset: 0; }`
    )
  }
  return rules.join('\n')
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

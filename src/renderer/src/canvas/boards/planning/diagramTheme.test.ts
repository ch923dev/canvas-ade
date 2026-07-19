// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  diagramTypeLabel,
  buildDiagramThemeVars,
  buildDiagramThemeCss,
  cacheMotionMatches,
  diagramMotionSentinel,
  withAlpha,
  DIAGRAM_STATUS_CLASSES
} from './diagramTheme'

describe('diagramTypeLabel', () => {
  it('reads the dialect from the first source token', () => {
    expect(diagramTypeLabel('graph TD\n A-->B')).toBe('flowchart')
    expect(diagramTypeLabel('flowchart LR\n A-->B')).toBe('flowchart')
    expect(diagramTypeLabel('sequenceDiagram\n A->>B: hi')).toBe('sequence')
    expect(diagramTypeLabel('erDiagram\n A ||--o{ B : x')).toBe('ER')
    expect(diagramTypeLabel('   classDiagram')).toBe('class')
    expect(diagramTypeLabel('mystery code')).toBe('diagram')
  })
})

describe('buildDiagramThemeVars — single-accent, neutral-elsewhere contract', () => {
  const vars = buildDiagramThemeVars()
  const accent = '#4f8cff'

  it('uses the accent ONLY on active/selected keys (no rainbow on base surfaces)', () => {
    // The accent is the one saturated colour, reserved for active/selected emphasis.
    expect(vars.activeTaskBkgColor).toBe(accent)
    expect(vars.activeTaskBorderColor).toBe(accent)
    // Base node/edge/text surfaces must NOT be the accent.
    for (const key of ['background', 'mainBkg', 'primaryColor', 'lineColor', 'textColor']) {
      expect(vars[key]).not.toBe(accent)
    }
  })

  it('themes to Geist + neutral dark surfaces', () => {
    expect(vars.fontFamily).toMatch(/Geist/)
    expect(vars.background).toBe('#141416')
    expect(vars.primaryColor).toBe('#1a1a1d')
  })

  it('pins erDiagram rows to dark surfaces via rowOdd/rowEven (the vars the erBox renderer reads)', () => {
    // The unified `erBox` shape fills rows from `rowOdd`/`rowEven` — Mermaid's base `rowOdd` default
    // is lighten(mainBkg,75%) ≈ near-white, which made our near-white text invisible. Both parities
    // must be dark so attribute text stays readable (the a11y fix).
    expect(vars.rowOdd).toBe('#1a1a1d')
    expect(vars.rowEven).toBe('#141416')
    expect(vars.rowOdd).not.toMatch(/#f{3,6}|#fff/i)
    expect(vars.rowEven).not.toMatch(/#f{3,6}|#fff/i)
    // Legacy alias kept in sync for older ER code paths.
    expect(vars.attributeBackgroundColorOdd).toBe('#1a1a1d')
    expect(vars.attributeBackgroundColorEven).toBe('#141416')
  })
})

describe('withAlpha', () => {
  it('converts hex to rgba at the given alpha', () => {
    expect(withAlpha('#3ecf8e', 0.5)).toBe('rgba(62, 207, 142, 0.5)')
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)')
  })
  it('passes non-hex tokens through unchanged (their alpha comes from the token)', () => {
    expect(withAlpha('rgba(1, 2, 3, 0.14)', 0.5)).toBe('rgba(1, 2, 3, 0.14)')
    expect(withAlpha('currentColor', 0.5)).toBe('currentColor')
  })
})

describe('buildDiagramThemeCss — semantic status classes + motion gating (S4b)', () => {
  const on = buildDiagramThemeCss(true)
  const off = buildDiagramThemeCss(false)

  it('styles every status class in the vocabulary', () => {
    for (const cls of DIAGRAM_STATUS_CLASSES) {
      expect(on).toContain(`.node.${cls}`)
      expect(off).toContain(`.node.${cls}`)
    }
  })

  it('keeps the saturated accent on ACTIVE only; other statuses use half-strength hue borders', () => {
    // active gets the full accent stroke…
    expect(on).toMatch(/\.node\.active[^}]+stroke: #4f8cff/)
    // …while done/warn/error borders are alpha'd status hues, never the raw accent.
    expect(on).toMatch(/\.node\.done[^}]+stroke: rgba\(62, 207, 142, 0\.5\)/)
    expect(on).toMatch(/\.node\.warn[^}]+stroke: rgba\(232, 179, 57, 0\.5\)/)
    expect(on).toMatch(/\.node\.error[^}]+stroke: rgba\(242, 84, 91, 0\.55\)/)
    // muted is de-emphasis, not colour.
    expect(on).toMatch(/\.node\.muted \{ opacity: 0\.55/)
  })

  it('motion ON restyles Mermaid edge-animation classes to the accent dash march', () => {
    expect(on).toContain('@keyframes expanse-flow')
    expect(on).toMatch(/\.edge-animation-fast[^}]+animation: expanse-flow 0\.9s linear infinite/)
    expect(on).toMatch(/\.edge-animation-slow[^}]+animation: expanse-flow 1\.8s/)
  })

  it('motion OFF forces the same classes static (reduced-motion contract)', () => {
    expect(off).not.toContain('@keyframes')
    expect(off).toMatch(
      /\.edge-animation-fast, \.edge-animation-slow[^}]+animation: none !important/
    )
    expect(off).toMatch(/stroke-dasharray: 0 !important/)
  })

  it('bakes exactly one motion sentinel so the SVG cache records its mode', () => {
    expect(on).toContain(diagramMotionSentinel(true))
    expect(on).not.toContain(diagramMotionSentinel(false))
    expect(off).toContain(diagramMotionSentinel(false))
    // Substring hazard guard: '…-off' must never satisfy a check for '…-on'.
    expect(cacheMotionMatches(on, true)).toBe(true)
    expect(cacheMotionMatches(off, false)).toBe(true)
    expect(cacheMotionMatches(off, true)).toBe(false)
    expect(cacheMotionMatches('<svg>old cache, no sentinel</svg>', true)).toBe(false)
    expect(cacheMotionMatches('<svg>old cache, no sentinel</svg>', false)).toBe(false)
  })
})

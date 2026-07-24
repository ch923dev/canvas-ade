/**
 * B1 — status-palette separability gate (diagram-viz Phase 1; CLAUDE-DESIGN-RESEARCH borrow B1).
 *
 * COMPUTES — never eyeballs — that the five status colours stay separable and readable on the
 * diagram surfaces, straight from `styles/tokens.css` (the design contract file). A token edit
 * that breaks separability FAILS the build here, extending the ER-contrast e2e philosophy from
 * one hard-coded case to a computed gate.
 *
 * Method ported from Anthropic's dataviz skill `validate_palette.js`: OKLab ΔE (Euclidean ×100)
 * under the Machado–Oliveira–Fernandes (2009) severity-1.0 CVD simulation, and WCAG relative-
 * luminance contrast. Thresholds are that standard's, applied to THIS palette's semantics:
 *  - CVD floor 6.0 (not the 8.0 target) is legal ONLY because status never ships colour-alone —
 *    every non-neutral status carries a glyph (specTheme.test.ts pins that), and muted adds a
 *    0.55-opacity third encoding. Current worst (protan warn↔done) is 8.8 — above target anyway.
 *  - `muted` (--text-3) is DEFINITIONALLY gray (chroma ≈ 0.009): it is excluded from the hue-
 *    separability pairs (it can never be hue-distinct under CVD; opacity + glyph carry it) and is
 *    instead gated as readable ink (≥ 3:1 on both surfaces).
 *  - Chart-palette checks that do NOT apply to a status palette (lightness band, chroma floor)
 *    are deliberately not gated.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// tokens.css is the source of truth — parse the REAL file, not a copy. Lives in scripts/ (the
// build-tooling test home, e2e-scope.test.ts precedent): the renderer tree's sandbox lint rightly
// bans node:fs there, and the vitest unit-node project resolves `?raw` CSS imports to empty.
const tokensCss = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/styles/tokens.css', import.meta.url)),
  'utf8'
)

function cssToken(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss)
  if (!m) throw new Error(`token ${name} not found in tokens.css`)
  return m[1].trim()
}
/** `#rrggbb` → [r,g,b] 0–255; `rgba(r, g, b, a)` → { rgb, a }. */
function parseHex(v: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(v)
  if (!m) throw new Error(`expected #rrggbb, got ${v}`)
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number]
}
function parseRgba(v: string): { rgb: [number, number, number]; a: number } {
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(v)
  if (!m) throw new Error(`expected rgba(), got ${v}`)
  return { rgb: [+m[1], +m[2], +m[3]], a: +m[4] }
}

// ── colour math (validate_palette.js port; Machado 2009 severity 1.0) ──────────
type RGB = [number, number, number]
const s2lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lin = (rgb: RGB): RGB => rgb.map((c) => s2lin(c / 255)) as RGB
const relLum = (rgb: RGB): number => {
  const [r, g, b] = lin(rgb)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: RGB, b: RGB): number => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const MACHADO: Record<'protan' | 'deutan', number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998]
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881]
  ]
}
function simulate(rgb: RGB, kind: 'protan' | 'deutan'): RGB {
  const [r, g, b] = lin(rgb)
  const M = MACHADO[kind]
  const clamp = (c: number): number => Math.max(0, Math.min(1, c))
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b)
  ]
}
function oklabFromLin([r, g, b]: RGB): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}
/** OKLab ΔE ×100; kind absent ⇒ unsimulated (normal) vision. */
function deltaE(c1: RGB, c2: RGB, kind?: 'protan' | 'deutan'): number {
  const a = oklabFromLin(kind ? simulate(c1, kind) : lin(c1))
  const b = oklabFromLin(kind ? simulate(c2, kind) : lin(c2))
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
/** Composite an rgba wash over an opaque surface (sRGB space — how CSS paints it). */
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as RGB
}

// ── the palette under test ─────────────────────────────────────────────────────
const surface = parseHex(cssToken('--surface'))
const raised = parseHex(cssToken('--surface-raised'))
const text = parseHex(cssToken('--text'))
const text3 = parseHex(cssToken('--text-3'))
const hues = {
  active: parseHex(cssToken('--accent')),
  done: parseHex(cssToken('--ok')),
  warn: parseHex(cssToken('--warn')),
  error: parseHex(cssToken('--err'))
}
const washes = {
  active: parseRgba(cssToken('--accent-wash')),
  done: parseRgba(cssToken('--ok-wash')),
  warn: parseRgba(cssToken('--warn-wash')),
  error: parseRgba(cssToken('--err-wash'))
}
const hueNames = Object.keys(hues) as (keyof typeof hues)[]

// Thresholds (dataviz standard; see header for why the 6.0 floor is legal here).
const CVD_FLOOR = 6.0
const NORMAL_FLOOR = 15.0
const GRAPHIC_MIN = 3.0 // WCAG non-text (glyphs, borders)
const TEXT_MIN = 4.5 // WCAG AA normal text (12px labels)

describe('B1 status-palette gate — CVD separability (computed, all pairs)', () => {
  it('keeps every hue-status pair ≥ ΔE 6.0 under protan AND deutan simulation', () => {
    for (let i = 0; i < hueNames.length; i++) {
      for (let j = i + 1; j < hueNames.length; j++) {
        for (const kind of ['protan', 'deutan'] as const) {
          const d = deltaE(hues[hueNames[i]], hues[hueNames[j]], kind)
          expect(
            d,
            `${hueNames[i]}↔${hueNames[j]} under ${kind} ΔE ${d.toFixed(1)} < ${CVD_FLOOR} — ` +
              `a token edit broke CVD separability (see specPalette.test.ts header)`
          ).toBeGreaterThanOrEqual(CVD_FLOOR)
        }
      }
    }
  })

  it('keeps every hue-status pair ≥ ΔE 15.0 under normal vision', () => {
    for (let i = 0; i < hueNames.length; i++) {
      for (let j = i + 1; j < hueNames.length; j++) {
        const d = deltaE(hues[hueNames[i]], hues[hueNames[j]])
        expect(
          d,
          `${hueNames[i]}↔${hueNames[j]} normal-vision ΔE ${d.toFixed(1)} < ${NORMAL_FLOOR}`
        ).toBeGreaterThanOrEqual(NORMAL_FLOOR)
      }
    }
  })
})

describe('B1 status-palette gate — contrast on the diagram surfaces (computed)', () => {
  it('every full-strength status hue reads as a mark (≥ 3:1) on --surface AND --surface-raised', () => {
    for (const name of hueNames) {
      for (const [sn, s] of [
        ['surface', surface],
        ['surface-raised', raised]
      ] as const) {
        const c = contrast(hues[name], s)
        expect(c, `${name} on ${sn} ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(GRAPHIC_MIN)
      }
    }
  })

  it('every status glyph (full hue) clears 3:1 on its OWN wash-filled node, both surfaces', () => {
    for (const name of hueNames) {
      const { rgb, a } = washes[name]
      for (const [sn, s] of [
        ['surface', surface],
        ['surface-raised', raised]
      ] as const) {
        const eff = over(rgb, a, s)
        const c = contrast(hues[name], eff)
        expect(c, `${name} glyph on its wash over ${sn} ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          GRAPHIC_MIN
        )
      }
    }
  })

  it('node label text (--text) stays AA (≥ 4.5:1) on every wash fill, both surfaces', () => {
    for (const name of hueNames) {
      const { rgb, a } = washes[name]
      for (const [sn, s] of [
        ['surface', surface],
        ['surface-raised', raised]
      ] as const) {
        const eff = over(rgb, a, s)
        const c = contrast(text, eff)
        expect(c, `--text on ${name} wash over ${sn} ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          TEXT_MIN
        )
      }
    }
  })

  it('the muted glyph ink (--text-3) reads (≥ 3:1) on both surfaces', () => {
    // muted is excluded from the hue pairs by design (gray by definition; opacity + glyph carry
    // it) but its glyph must still be legible ink before the 0.55 de-emphasis applies.
    for (const [sn, s] of [
      ['surface', surface],
      ['surface-raised', raised]
    ] as const) {
      const c = contrast(text3, s)
      expect(c, `--text-3 on ${sn} ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(GRAPHIC_MIN)
    }
  })
})

describe('B1 status-palette gate — token↔fallback parity (drift tripwire)', () => {
  it('tokens.css values match the specTheme/diagramTheme hard fallbacks', async () => {
    // The theme bridges read tokens live and fall back to literals when headless; a token edit
    // that skips the fallbacks would let tests validate one palette while the app renders another.
    const { specStatusStyle } = await import('@expanse-ade/diagram')
    expect(cssToken('--accent')).toBe('#4f8cff')
    expect(cssToken('--ok')).toBe('#3ecf8e')
    expect(cssToken('--warn')).toBe('#e8b339')
    expect(cssToken('--err')).toBe('#f2545b')
    expect(cssToken('--surface')).toBe('#141416')
    expect(cssToken('--surface-raised')).toBe('#1a1a1d')
    // And the bridge's fallback recipe agrees with the tokens (jsdom-free node env ⇒ fallbacks).
    expect(specStatusStyle('done').glyphColor).toBe(cssToken('--ok'))
    expect(specStatusStyle('active').border).toBe(cssToken('--accent'))
  })
})

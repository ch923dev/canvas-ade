import { describe, it, expect } from 'vitest'
import { boardToSvg, ARROW_COLOR } from './whiteboardExport'
import type { PlanningBoard } from '../../../lib/boardSchema'

const board = (elements: PlanningBoard['elements']): PlanningBoard => ({
  id: 'p1',
  type: 'planning',
  x: 0,
  y: 0,
  w: 516,
  h: 366,
  title: 'Plan',
  elements
})

describe('boardToSvg — frame', () => {
  it('an empty board exports a non-empty, well-formed svg with a background rect', () => {
    const { svg, width, height } = boardToSvg(board([]), {})
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.includes('xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trim().endsWith('</svg>')).toBe(true)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(svg).toContain('#141416')
  })

  it('sizes the viewport to the element union plus padding (origin-normalised)', () => {
    const { width, height } = boardToSvg(
      board([{ id: 's', kind: 'stroke', x: 0, y: 0, points: [100, 100, 140, 160] }]),
      {}
    )
    // union is 40×60 at (100,100); + 2*PAD(24) → 88×108
    expect(width).toBe(88)
    expect(height).toBe(108)
  })
})

describe('boardToSvg — vectors', () => {
  it('emits a bezier path for an arrow and a fill path for a stroke', () => {
    const { svg } = boardToSvg(
      board([
        { id: 'a', kind: 'arrow', x: 10, y: 10, x2: 90, y2: 70 },
        { id: 's', kind: 'stroke', x: 0, y: 0, points: [10, 10, 40, 40, 70, 20] }
      ]),
      {}
    )
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(svg).toContain(' C ') // cubic bezier from arrowPath
    expect(svg).toContain(ARROW_COLOR)
  })

  it('renders an arrowhead marker so the arrow has a head', () => {
    const { svg } = boardToSvg(board([{ id: 'a', kind: 'arrow', x: 0, y: 0, x2: 50, y2: 0 }]), {})
    expect(svg).toContain('<marker')
    expect(svg).toContain('marker-end="url(#wb-export-arrow)"')
  })
})

describe('boardToSvg — cards', () => {
  it('renders a note as a tinted rounded rect with its text', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 'n',
          kind: 'note',
          x: 0,
          y: 0,
          w: 156,
          h: 96,
          tint: 'yellow',
          text: 'hello',
          rotation: 0
        }
      ]),
      {}
    )
    expect(svg).toContain('<rect')
    expect(svg).toContain('#2a2818') // yellow tint fill
    expect(svg).toContain('hello')
  })

  it('escapes text content (no raw markup injection)', () => {
    const { svg } = boardToSvg(
      board([{ id: 't', kind: 'text', x: 0, y: 0, text: '<b>x</b> & y' }]),
      {}
    )
    expect(svg).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(svg).not.toContain('<b>x</b>')
  })

  it('renders a checklist with title, count, progress bar and item labels', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 'c',
          kind: 'checklist',
          x: 0,
          y: 0,
          w: 240,
          h: 0,
          title: 'Tasks',
          items: [
            { id: 'i1', label: 'done one', done: true },
            { id: 'i2', label: 'todo two', done: false }
          ]
        }
      ]),
      {}
    )
    expect(svg).toContain('Tasks')
    expect(svg).toContain('1/2') // done/total
    expect(svg).toContain('done one')
    expect(svg).toContain('todo two')
  })
})

describe('boardToSvg — images', () => {
  const img = { id: 'im', kind: 'image' as const, x: 0, y: 0, w: 120, h: 80, assetId: 'abc.png' }

  it('embeds the bitmap as an <image> with the supplied data URI', () => {
    const dataUri = 'data:image/png;base64,AAAA'
    const res = boardToSvg(board([img]), { 'abc.png': dataUri })
    expect(res.svg).toContain('<image')
    expect(res.svg).toContain(dataUri)
    expect(res.imageCount).toBe(1)
    expect(res.embeddedCount).toBe(1)
  })

  it('draws a dashed fallback tile (no throw) when the asset is missing', () => {
    const res = boardToSvg(board([img]), {}) // asset absent
    expect(res.svg).not.toContain('<image')
    expect(res.svg).toContain('stroke-dasharray')
    expect(res.imageCount).toBe(1)
    expect(res.embeddedCount).toBe(0)
  })
})

describe('boardToSvg — text typography (v7)', () => {
  it('a text element with NO tokens exports identically to the pre-typography baseline', () => {
    const { svg } = boardToSvg(board([{ id: 't', kind: 'text', x: 10, y: 10, text: 'plain' }]), {})
    expect(svg).toContain('font-size="13"')
    expect(svg).toContain('font-family="system-ui, -apple-system, Segoe UI, sans-serif"')
    expect(svg).toContain('fill="#ededee"')
    expect(svg).not.toContain('text-anchor=') // left is the default → no anchor attr
  })

  it('multi-line text uses lineHeightFor for tspan spacing (matches the live board)', () => {
    const { svg } = boardToSvg(
      board([{ id: 't', kind: 'text', x: 0, y: 0, text: 'one\ntwo', fontSize: 'XL' }]),
      {}
    )
    // lineHeightFor(26) === 36, NOT the legacy 26 + 4 === 30.
    expect(svg).toContain('dy="36"')
    expect(svg).not.toContain('dy="30"')
  })

  it('multi-line note keeps the legacy line spacing (byte-identical export preserved)', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 'n',
          kind: 'note',
          x: 0,
          y: 0,
          w: 156,
          h: 96,
          tint: 'yellow',
          text: 'a\nb',
          rotation: 0
        }
      ]),
      {}
    )
    // Notes still use size(12) + 4 === 16 — only free-text adopted lineHeightFor.
    expect(svg).toContain('dy="16"')
  })

  it('center-aligned text anchors at the estimated content center (scales with length)', () => {
    const ax = (s: string): number => parseFloat(s.match(/<text x="(-?[\d.]+)"/)![1])
    const short = boardToSvg(
      board([{ id: 't', kind: 'text', x: 100, y: 0, text: 'hi', align: 'center' }]),
      {}
    ).svg
    const long = boardToSvg(
      board([
        { id: 't', kind: 'text', x: 100, y: 0, text: 'a much longer line here', align: 'center' }
      ]),
      {}
    ).svg
    // Longer content → the center anchor sits further right (no longer pinned to a fixed 120px box).
    expect(ax(long)).toBeGreaterThan(ax(short))
  })

  it('honors family / size / weight / color / align tokens', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 't',
          kind: 'text',
          x: 10,
          y: 10,
          text: 'styled',
          fontFamily: 'mono',
          fontSize: 'XL',
          align: 'center',
          color: 'accent',
          bold: true
        }
      ]),
      {}
    )
    expect(svg).toContain('font-size="26"')
    expect(svg).toContain('font-weight="700"')
    expect(svg).toContain('Cascadia Mono, Consolas, ui-monospace, monospace')
    expect(svg).toContain('fill="#4f8cff"')
    expect(svg).toContain('text-anchor="middle"')
  })

  it('serif family exports a well-formed font-family attribute (no embedded double-quotes)', () => {
    const { svg } = boardToSvg(
      board([{ id: 't', kind: 'text', x: 10, y: 10, text: 'serifed', fontFamily: 'serif' }]),
      {}
    )
    // An embedded `"` inside the value would terminate the `font-family="…"` attribute early,
    // silently truncating the stack to `Georgia,` → default-font fallback in every SVG renderer.
    expect(svg).toContain('font-family="Georgia, Times New Roman, serif"')
    expect(svg).not.toContain('font-family="Georgia, "')
  })
})

describe('boardToSvg — text wrapping (matches the on-board wrap; no overflow/clip)', () => {
  const longText = Array(30).fill('word').join(' ')
  // The first <text> element's full markup (notes/area-text are emitted as one <text> of <tspan>s).
  const firstText = (svg: string): string => svg.match(/<text[^>]*>.*?<\/text>/s)?.[0] ?? ''
  const tspans = (markup: string): number => (markup.match(/<tspan/g) ?? []).length

  it('wraps a long note label to several lines and grows the card + the canvas to fit', () => {
    const { svg, height } = boardToSvg(
      board([
        {
          id: 'n',
          kind: 'note',
          x: 0,
          y: 0,
          w: 156,
          h: 96,
          tint: 'yellow',
          text: longText,
          rotation: 0
        }
      ]),
      {}
    )
    expect(tspans(firstText(svg))).toBeGreaterThan(1) // wrapped, not one overflowing line
    // The note rect (rx="6") grew past the nominal h:96 …
    const rectH = parseFloat(svg.match(/height="([\d.]+)" rx="6"/)![1])
    expect(rectH).toBeGreaterThan(96)
    // … and the SVG canvas grew with it (nominal would be 96 + 2*PAD = 144).
    expect(height).toBeGreaterThan(144)
  })

  it('wraps area-text (explicit width) to its box', () => {
    const { svg } = boardToSvg(
      board([{ id: 't', kind: 'text', x: 0, y: 0, text: longText, width: 90 }]),
      {}
    )
    expect(tspans(firstText(svg))).toBeGreaterThan(1)
  })

  it('does NOT wrap auto-text (no width) — mirrors FreeText auto-sizing to content', () => {
    const { svg } = boardToSvg(board([{ id: 't', kind: 'text', x: 0, y: 0, text: longText }]), {})
    expect(tspans(firstText(svg))).toBe(1)
  })

  it('wraps a long checklist item label and grows the card height', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 'c',
          kind: 'checklist',
          x: 0,
          y: 0,
          w: 240,
          h: 0,
          title: 'T',
          items: [{ id: 'i1', label: longText, done: false }]
        }
      ]),
      {}
    )
    // The checklist background rect is the only rx="8" rect; it grew past the single-item nominal
    // (nominalChecklistHeight(1) === 30 + 24 + 24 === 78) because the label wrapped to several rows.
    const cardH = parseFloat(svg.match(/height="([\d.]+)" rx="8"/)![1])
    expect(cardH).toBeGreaterThan(78)
  })

  it('uses the INJECTED measurer for wrap decisions (the DI seam the export backs with canvas)', () => {
    // A measurer that reports every string as huge forces each word onto its own line.
    const huge = (): number => 9999
    const { svg } = boardToSvg(
      board([
        {
          id: 'n',
          kind: 'note',
          x: 0,
          y: 0,
          w: 156,
          h: 96,
          tint: 'yellow',
          text: 'a b c',
          rotation: 0
        }
      ]),
      {},
      huge
    )
    expect(tspans(firstText(svg))).toBe(3)
  })
})

/**
 * Pure SVG serializer for a Planning board (W5 export). Renders every element kind
 * to standalone SVG markup in board-local coordinates, normalised so the element
 * union sits at PAD from the origin. No DOM, no React, no store — the impure driver
 * (exportBoard.ts) supplies the resolved `assets` map and rasterizes to PNG.
 *
 * Geometry reuses the live vector builders (arrowPath/strokeToPath) and elementBBox
 * so the export matches what's on the board. Text-bearing kinds (note / area-text /
 * checklist label) WRAP to their box width — `boardToSvg` takes a `measureText` the impure
 * driver backs with a real `canvas.measureText` so the wrap (and the grown box + canvas size)
 * matches the rasterized output; a pure heuristic is the node-test fallback. The note/checklist
 * boxes and the SVG canvas grow to fit the wrapped content so nothing overflows or clips.
 */
import type { PlanningBoard, PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, unionBBox, nominalChecklistHeight, type BBox } from './elements'
import { EXPORT_COLORS, EXPORT_NOTE_TINTS } from './exportColors'
import { arrowPath, strokeToPath } from './svgPaths'
import {
  SIZE_PX,
  COLOR_EXPORT,
  FAMILY_EXPORT,
  ANCHOR,
  WEIGHT,
  TEXT_DEFAULTS,
  MIN_TEXT_WIDTH_PX,
  lineHeightFor,
  estimateLineWidth,
  wrapText,
  type MeasureText
} from './textStyle'

/** assetId → data-URI (base64) for image elements; missing ids are absent. */
export type ExportAssets = Record<string, string>

export interface ExportResult {
  svg: string
  width: number
  height: number
  /** number of image elements on the board. */
  imageCount: number
  /** number of image elements whose bitmap was embedded (asset present). */
  embeddedCount: number
}

const PAD = 24

/** Re-exported so tests + callers can assert the vector ink colour. */
export const ARROW_COLOR = EXPORT_COLORS.borderStrong
const STROKE_FILL = EXPORT_COLORS.text2
const ARROW_MARKER_ID = 'wb-export-arrow'

// The default export font = the canonical sans stack (single source; checklist inline
// <text> nodes + textBlock's default both use it → no R7-class drift).
const FONT = FAMILY_EXPORT.sans
const R_INNER = 6
const R_BOARD = 8

/** XML-escape text content / attribute values. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A multi-line <text> block: one <tspan> per source line. `anchor` defaults to 'start'
 *  (left) so existing callers (note/checklist) emit byte-identical markup. */
function textBlock(
  x: number,
  y: number,
  raw: string,
  size: number,
  fill: string,
  weight = 400,
  family: string = FONT,
  anchor: 'start' | 'middle' | 'end' = 'start',
  // Inter-line spacing. Defaults to the legacy `size + 4` so note/checklist callers
  // emit byte-identical markup; free-text passes lineHeightFor(px) to match the board.
  lineHeight: number = size + 4
): string {
  const lines = raw.split('\n')
  const tspans = lines
    .map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${esc(ln)}</tspan>`)
    .join('')
  const a = anchor !== 'start' ? ` text-anchor="${anchor}"` : ''
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}"${a} fill="${fill}">${tspans}</text>`
}

export function boardToSvg(
  board: PlanningBoard,
  assets: ExportAssets,
  // Real (canvas-backed) measurer from the impure driver → pixel-accurate wrap; the heuristic is the
  // pure node-test fallback. Width-bearing wrap (note/area-text/checklist) depends on this.
  measure: MeasureText = estimateLineWidth
): ExportResult {
  const els = board.elements
  // Render first, then union the bboxes each element REPORTS: a wrapped note/checklist grows past
  // its schema h, and free text has no persisted w/h — so the SVG canvas must size to the rendered
  // extent, not the nominal `elementBBox`, or tall/long text clips at the frame edge.
  const rendered = els.map((el) => renderElement(el, assets, measure))
  const boxes = rendered.map((r) => r.bbox)
  const union = boxes.length ? unionBBox(boxes) : { x: 0, y: 0, w: 240, h: 160 }
  const width = Math.max(1, Math.round(union.w + PAD * 2))
  const height = Math.max(1, Math.round(union.h + PAD * 2))
  // Translate so the union's top-left lands at (PAD, PAD).
  const ox = PAD - union.x
  const oy = PAD - union.y

  let imageCount = 0
  let embeddedCount = 0
  const body: string[] = []
  els.forEach((el, i) => {
    const r = rendered[i]
    body.push(r.markup)
    if (el.kind === 'image') {
      imageCount++
      if (r.embedded) embeddedCount++
    }
  })

  const defs =
    `<defs><marker id="${ARROW_MARKER_ID}" markerWidth="8" markerHeight="8" ` +
    `refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="${ARROW_COLOR}"/></marker></defs>`

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    defs +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${EXPORT_COLORS.surface}"/>` +
    `<g transform="translate(${ox} ${oy})">${body.join('')}</g>` +
    `</svg>`

  return { svg, width, height, imageCount, embeddedCount }
}

// Note inner padding (NoteCard grip `9px 11px`) + textarea line-height (16) + first-line baseline.
const NOTE_PAD_X = 11
const NOTE_PAD_Y = 9
const NOTE_FS = 12
const NOTE_LH = 16
// Checklist label column: text starts at x+37 (12 pad + 16 checkbox + 9 gap), 12 right pad. Rows
// step by 24 (header→first row) and grow when a label wraps; label font 12 / line-height 16.
const CL_LABEL_X = 37
const CL_RIGHT_PAD = 12
const CL_ROW_STEP = 24
const CL_LABEL_FS = 12
const CL_LABEL_LH = 16

/** Render one element to SVG markup + the board-local box it actually occupies (drives the SVG
 *  canvas size). `embedded` is true ONLY for an image whose bitmap data-URI was inlined. */
function renderElement(
  el: PlanningElement,
  assets: ExportAssets,
  measure: MeasureText
): { markup: string; embedded: boolean; bbox: BBox } {
  switch (el.kind) {
    case 'arrow':
      return {
        markup:
          `<path d="${arrowPath(el)}" fill="none" stroke="${ARROW_COLOR}" ` +
          `stroke-width="1.5" marker-end="url(#${ARROW_MARKER_ID})"/>`,
        embedded: false,
        bbox: elementBBox(el)
      }
    case 'stroke': {
      const d = strokeToPath(el.points)
      return {
        markup: d ? `<path d="${d}" fill="${STROKE_FILL}"/>` : '',
        embedded: false,
        bbox: elementBBox(el)
      }
    }
    case 'note': {
      const t = EXPORT_NOTE_TINTS[el.tint]
      const rot = el.rotation ?? 0
      // Wrap to the textarea content width (card width minus the grip's left+right padding), then
      // grow the box to fit — matching NoteCard's soft-wrapping auto-height textarea.
      const contentW = Math.max(1, el.w - NOTE_PAD_X * 2)
      const lines = wrapText(el.text, contentW, NOTE_FS, 'sans', measure)
      const boxH = Math.max(el.h, NOTE_PAD_Y * 2 + lines.length * NOTE_LH)
      const cx = el.x + el.w / 2
      const cy = el.y + boxH / 2
      return {
        markup:
          `<g transform="rotate(${rot} ${cx} ${cy})">` +
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${boxH}" rx="${R_INNER}" ` +
          `fill="${t.fill}" stroke="${t.edge}" stroke-width="1"/>` +
          // textBlock's default lineHeight (size + 4 === 16) === NOTE_LH, so spacing is unchanged.
          textBlock(el.x + NOTE_PAD_X, el.y + 20, lines.join('\n'), NOTE_FS, EXPORT_COLORS.text) +
          `</g>`,
        embedded: false,
        bbox: { x: el.x, y: el.y, w: el.w, h: boxH }
      }
    }
    case 'text': {
      // Fallbacks resolve through TEXT_DEFAULTS (single source of truth) so a change to a
      // default can't silently drift the export away from the live board (the R7 lesson).
      const fam = el.fontFamily ?? TEXT_DEFAULTS.fontFamily
      const px = SIZE_PX[el.fontSize ?? TEXT_DEFAULTS.fontSize]
      const align = el.align ?? TEXT_DEFAULTS.align
      const colorTok = el.color ?? TEXT_DEFAULTS.color
      const weight = el.bold ? WEIGHT.bold : WEIGHT.normal
      const lh = lineHeightFor(px)
      // Area text (explicit width) WRAPS to its box like FreeText's `white-space:pre-wrap`; auto
      // text keeps its source lines (FreeText auto-sizes width to content → no wrap) — matching the
      // live board. Box width = the fixed width, or the widest rendered line for auto text.
      const lines =
        el.width !== undefined ? wrapText(el.text, el.width, px, fam, measure) : el.text.split('\n')
      const boxW = el.width ?? Math.max(MIN_TEXT_WIDTH_PX, ...lines.map((l) => measure(l, px, fam)))
      // Anchor x for center/right from the box width; left stays exact at el.x. Baseline el.y + px +
      // 3 === el.y + 16 at px=13, keeping default left text byte-identical to pre-typography.
      const ax = align === 'center' ? el.x + boxW / 2 : align === 'right' ? el.x + boxW : el.x
      return {
        markup: textBlock(
          ax,
          el.y + px + 3,
          lines.join('\n'),
          px,
          COLOR_EXPORT[colorTok],
          weight,
          FAMILY_EXPORT[fam],
          ANCHOR[align],
          lh
        ),
        embedded: false,
        bbox: { x: el.x, y: el.y, w: boxW, h: Math.max(lh, lines.length * lh) }
      }
    }
    case 'checklist': {
      const total = el.items.length
      const done = el.items.filter((i) => i.done).length
      const pct = total === 0 ? 0 : Math.round((done / total) * 100)
      const labelW = Math.max(1, el.w - CL_LABEL_X - CL_RIGHT_PAD)
      const parts: string[] = []
      parts.push(textBlock(el.x + 12, el.y + 22, el.title, 12.5, EXPORT_COLORS.text, 600))
      parts.push(
        `<text x="${el.x + el.w - 12}" y="${el.y + 22}" text-anchor="end" font-family="${FONT}" ` +
          `font-size="11" fill="${EXPORT_COLORS.text3}">${esc(`${done}/${total}`)}</text>`
      )
      const barY = el.y + 30
      parts.push(
        `<rect x="${el.x + 12}" y="${barY}" width="${el.w - 24}" height="3" rx="1.5" fill="${EXPORT_COLORS.inset}"/>`
      )
      if (pct > 0) {
        parts.push(
          `<rect x="${el.x + 12}" y="${barY}" width="${((el.w - 24) * pct) / 100}" height="3" rx="1.5" fill="${EXPORT_COLORS.accent}"/>`
        )
      }
      // Rows advance by the wrapped line count (≥ one step) so a multi-line label never overlaps
      // the next row — mirroring ChecklistCard's auto-growing label textareas.
      let ry = el.y + 30 + CL_ROW_STEP // first row's first-line baseline
      let bottom = barY + 3
      el.items.forEach((it) => {
        const labelLines = wrapText(it.label, labelW, CL_LABEL_FS, 'sans', measure)
        const boxStroke = it.done ? EXPORT_COLORS.accent : EXPORT_COLORS.borderStrong
        const boxFill = it.done ? EXPORT_COLORS.accent : 'none'
        parts.push(
          `<rect x="${el.x + 12}" y="${ry - 12}" width="16" height="16" rx="5" fill="${boxFill}" stroke="${boxStroke}" stroke-width="1.5"/>`
        )
        if (it.done) {
          parts.push(
            `<path d="M${el.x + 15} ${ry - 4} l3 3 l5 -6" fill="none" stroke="${EXPORT_COLORS.void}" stroke-width="2"/>`
          )
        }
        const labelFill = it.done ? EXPORT_COLORS.textFaint : EXPORT_COLORS.text2
        const deco = it.done ? ` text-decoration="line-through"` : ''
        const tspans = labelLines
          .map(
            (ln, i) =>
              `<tspan x="${el.x + CL_LABEL_X}" dy="${i === 0 ? 0 : CL_LABEL_LH}">${esc(ln)}</tspan>`
          )
          .join('')
        parts.push(
          `<text x="${el.x + CL_LABEL_X}" y="${ry}" font-family="${FONT}" font-size="${CL_LABEL_FS}" fill="${labelFill}"${deco}>${tspans}</text>`
        )
        const rowH = Math.max(CL_ROW_STEP, labelLines.length * CL_LABEL_LH)
        bottom = ry - 12 + Math.max(16, labelLines.length * CL_LABEL_LH)
        ry += rowH
      })
      // Card height: never shorter than the nominal box; grow to the last row's bottom + footer.
      const cardH = Math.max(nominalChecklistHeight(total), bottom - el.y + 12)
      // Background rect drawn first (under everything) now that the final height is known.
      parts.unshift(
        `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${cardH}" rx="${R_BOARD}" ` +
          `fill="${EXPORT_COLORS.surfaceRaised}" stroke="${EXPORT_COLORS.border}" stroke-width="1"/>`
      )
      return {
        markup: parts.join(''),
        embedded: false,
        bbox: { x: el.x, y: el.y, w: el.w, h: cardH }
      }
    }
    case 'image': {
      const uri = assets[el.assetId]
      if (uri) {
        return {
          markup:
            `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" ` +
            `preserveAspectRatio="xMidYMid meet" href="${esc(uri)}"/>`,
          embedded: true,
          bbox: elementBBox(el)
        }
      }
      return {
        markup:
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${R_INNER}" ` +
          `fill="none" stroke="${EXPORT_COLORS.border}" stroke-width="1" stroke-dasharray="4 3"/>`,
        embedded: false,
        bbox: elementBBox(el)
      }
    }
    case 'diagram': {
      // Embed the derived SVG cache as an inline <image> data URI (same path as a bitmap image);
      // a missing/unrendered cache draws the dashed fallback tile so export never throws.
      const uri = el.svgCache ? assets[el.svgCache] : undefined
      if (uri) {
        return {
          markup:
            `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" ` +
            `preserveAspectRatio="xMidYMid meet" href="${esc(uri)}"/>`,
          embedded: true,
          bbox: elementBBox(el)
        }
      }
      return {
        markup:
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${R_INNER}" ` +
          `fill="none" stroke="${EXPORT_COLORS.border}" stroke-width="1" stroke-dasharray="4 3"/>`,
        embedded: false,
        bbox: elementBBox(el)
      }
    }
    default:
      // fileref + any future kind: no bespoke vector yet, but still claim its nominal box so the
      // SVG canvas reserves space for it (preserves the pre-wrap union behaviour for these kinds).
      return { markup: '', embedded: false, bbox: elementBBox(el) }
  }
}

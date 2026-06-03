/**
 * Pure SVG serializer for a Planning board (W5 export). Renders every element kind
 * to standalone SVG markup in board-local coordinates, normalised so the element
 * union sits at PAD from the origin. No DOM, no React, no store — the impure driver
 * (exportBoard.ts) supplies the resolved `assets` map and rasterizes to PNG.
 *
 * Geometry reuses the live vector builders (arrowPath/strokeToPath) and elementBBox
 * so the export matches what's on the board. Auto-sized kinds (text/checklist) use
 * their nominal sizes (no live DOM measurement at export time) — close enough for a
 * one-shot deliverable.
 */
import type { PlanningBoard, PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, unionBBox, nominalChecklistHeight, TEXT_NOMINAL } from './elements'
import { EXPORT_COLORS, EXPORT_NOTE_TINTS } from './exportColors'
import { arrowPath, strokeToPath } from './svgPaths'

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

const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif'
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

/** A multi-line <text> block: one <tspan> per source line, left-aligned at (x,y). */
function textBlock(
  x: number,
  y: number,
  raw: string,
  size: number,
  fill: string,
  weight = 400
): string {
  const lines = raw.split('\n')
  const tspans = lines
    .map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size + 4}">${esc(ln)}</tspan>`)
    .join('')
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${tspans}</text>`
}

export function boardToSvg(board: PlanningBoard, assets: ExportAssets): ExportResult {
  const els = board.elements
  const boxes = els.map((e) => elementBBox(e))
  const union = boxes.length ? unionBBox(boxes) : { x: 0, y: 0, w: 240, h: 160 }
  const width = Math.max(1, Math.round(union.w + PAD * 2))
  const height = Math.max(1, Math.round(union.h + PAD * 2))
  // Translate so the union's top-left lands at (PAD, PAD).
  const ox = PAD - union.x
  const oy = PAD - union.y

  let imageCount = 0
  let embeddedCount = 0
  const body: string[] = []
  for (const el of els) {
    const r = renderElement(el, assets)
    body.push(r.markup)
    if (el.kind === 'image') {
      imageCount++
      if (r.embedded) embeddedCount++
    }
  }

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

/** Render one element to SVG markup. `embedded` is true ONLY for an image whose
 *  bitmap data-URI was successfully inlined (drives ExportResult.embeddedCount). */
function renderElement(
  el: PlanningElement,
  assets: ExportAssets
): { markup: string; embedded: boolean } {
  switch (el.kind) {
    case 'arrow':
      return {
        markup:
          `<path d="${arrowPath(el)}" fill="none" stroke="${ARROW_COLOR}" ` +
          `stroke-width="1.5" marker-end="url(#${ARROW_MARKER_ID})"/>`,
        embedded: false
      }
    case 'stroke': {
      const d = strokeToPath(el.points)
      return { markup: d ? `<path d="${d}" fill="${STROKE_FILL}"/>` : '', embedded: false }
    }
    case 'note': {
      const t = EXPORT_NOTE_TINTS[el.tint]
      const rot = el.rotation ?? 0
      const cx = el.x + el.w / 2
      const cy = el.y + el.h / 2
      return {
        markup:
          `<g transform="rotate(${rot} ${cx} ${cy})">` +
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${R_INNER}" ` +
          `fill="${t.fill}" stroke="${t.edge}" stroke-width="1"/>` +
          textBlock(el.x + 11, el.y + 20, el.text, 12, EXPORT_COLORS.text) +
          `</g>`,
        embedded: false
      }
    }
    case 'text':
      return {
        markup: textBlock(el.x, el.y + TEXT_NOMINAL.h - 6, el.text, 13, EXPORT_COLORS.text),
        embedded: false
      }
    case 'checklist': {
      const total = el.items.length
      const done = el.items.filter((i) => i.done).length
      const pct = total === 0 ? 0 : Math.round((done / total) * 100)
      const h = nominalChecklistHeight(total)
      const parts: string[] = []
      parts.push(
        `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${h}" rx="${R_BOARD}" ` +
          `fill="${EXPORT_COLORS.surfaceRaised}" stroke="${EXPORT_COLORS.border}" stroke-width="1"/>`
      )
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
      el.items.forEach((it, idx) => {
        const ry = el.y + 30 + 24 + idx * 24
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
        parts.push(
          `<text x="${el.x + 37}" y="${ry}" font-family="${FONT}" font-size="12" fill="${labelFill}"${deco}>${esc(it.label)}</text>`
        )
      })
      return { markup: parts.join(''), embedded: false }
    }
    case 'image': {
      const uri = assets[el.assetId]
      if (uri) {
        return {
          markup:
            `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" ` +
            `preserveAspectRatio="xMidYMid meet" href="${esc(uri)}"/>`,
          embedded: true
        }
      }
      return {
        markup:
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${R_INNER}" ` +
          `fill="none" stroke="${EXPORT_COLORS.border}" stroke-width="1" stroke-dasharray="4 3"/>`,
        embedded: false
      }
    }
    default:
      return { markup: '', embedded: false }
  }
}

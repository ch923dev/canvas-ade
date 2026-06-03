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
import { elementBBox, unionBBox } from './elements'
import { EXPORT_COLORS } from './exportColors'
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

/** XML-escape text content / attribute values. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
function renderElement(el: PlanningElement, _assets: ExportAssets): { markup: string; embedded: boolean } {
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
    default:
      return { markup: '', embedded: false }
  }
}

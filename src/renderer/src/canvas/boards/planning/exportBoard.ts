/**
 * Impure renderer-side driver for W5 whiteboard export. Resolves each image
 * element's bytes to a base64 data URI (asset.read — INTO THE ARTIFACT ONLY, never
 * canvas.json), builds the standalone SVG via the pure boardToSvg, and rasterizes
 * it to a PNG Uint8Array through an offscreen <canvas>. A missing asset is skipped
 * (boardToSvg draws the fallback tile) — never throws.
 */
import type { PlanningBoard } from '../../../lib/boardSchema'
import { boardToSvg, type ExportResult } from './whiteboardExport'

/** Bytes → `data:<mime>;base64,<…>` (chunked to avoid a call-stack blowup on large blobs). */
function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** Gather assetId → data URI for every image element (missing → absent in the map). */
async function gatherAssets(board: PlanningBoard): Promise<Record<string, string>> {
  const ids = Array.from(
    new Set(
      board.elements
        .filter((e) => e.kind === 'image')
        .map((e) => {
          // TypeScript narrows e to ImageElement after the kind === 'image' filter above.
          // The filter callback's return is not narrowed at the map call site in all TS
          // versions, so we assert the discriminated member directly — ImageElement has
          // assetId: string (boardSchema.ts line 113), and the filter guarantees it.
          if (e.kind !== 'image') return ''
          return e.assetId
        })
        .filter((id) => id.length > 0)
    )
  )
  const map: Record<string, string> = {}
  await Promise.all(
    ids.map(async (id) => {
      try {
        const bytes = await window.api.asset.read(id)
        if (bytes && bytes.length) {
          const ext = id.split('.').pop() ?? ''
          map[id] = bytesToDataUri(bytes, MIME_BY_EXT[ext] ?? 'application/octet-stream')
        }
      } catch {
        /* missing/unreadable → leave absent so boardToSvg draws the fallback */
      }
    })
  )
  return map
}

/** Render the SVG into an offscreen canvas and return PNG bytes. */
async function rasterize(result: ExportResult): Promise<Uint8Array> {
  const { svg, width, height } = result
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg image load failed'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0, width, height)
    const pngBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!pngBlob) throw new Error('toBlob returned null')
    return new Uint8Array(await pngBlob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface BuiltExport {
  result: ExportResult
  /** SVG bytes (UTF-8) for `format:'svg'`; PNG bytes for `format:'png'`. */
  bytes: Uint8Array
  ext: 'png' | 'svg'
}

/** Build the export artifact bytes for a board in the requested format. */
export async function buildExport(
  board: PlanningBoard,
  format: 'png' | 'svg'
): Promise<BuiltExport> {
  const assets = await gatherAssets(board)
  const result = boardToSvg(board, assets)
  if (format === 'svg') {
    return { result, bytes: new TextEncoder().encode(result.svg), ext: 'svg' }
  }
  return { result, bytes: await rasterize(result), ext: 'png' }
}

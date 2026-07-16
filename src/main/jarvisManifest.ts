/**
 * Jarvis J3 — the per-turn workspace manifest (REVIEW §3.4 semantic targeting): a compact
 * text projection of the live AppModel (id, type, title, status, geometry summary, group)
 * so the brain can resolve "the auth terminal" to a concrete board. Pure: AppModel in,
 * bounded string out. The AppModel itself comes from RunningMcp.describeApp() in-process
 * (read-only, token-free) — no HTTP, no MCP wire read.
 */
import type { AppModel, AppModelBoard } from './appModel'

/** Bounds keeping the manifest prompt-cheap no matter how big the canvas grows. */
export const MANIFEST_MAX_BOARDS = 40
const TITLE_MAX = 48

/**
 * 🔒 BRAIN-5 (J4 injection audit): board titles and group names are USER/AGENT-authored free
 * text that embeds into the SYSTEM prompt. A title carrying a newline could forge extra
 * manifest lines ("fake boards"), or break out of the Workspace block entirely and inject
 * persona-level instructions — inert while the brain was toolless, an action seam now that J4
 * ships tools. Neutralize every C0/C1 control (incl. \r\n\t) plus the Unicode line/paragraph
 * separators to a plain space BEFORE clipping, so one board = exactly one manifest line and
 * the block's structure is host-owned. Length caps alone (the old clip) do not do this.
 */
function neutralize(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
}

function clip(s: string, max: number): string {
  const flat = neutralize(s)
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

/** Coarse screen-region word for a board's center within the canvas bounding box. */
export function regionOf(b: AppModelBoard, bounds: Bounds | null): string | null {
  if (!bounds || b.x === undefined || b.y === undefined) return null
  const cx = b.x + (b.w ?? 0) / 2
  const cy = b.y + (b.h ?? 0) / 2
  const fx = bounds.w > 0 ? (cx - bounds.x) / bounds.w : 0.5
  const fy = bounds.h > 0 ? (cy - bounds.y) / bounds.h : 0.5
  const col = fx < 0.34 ? 'left' : fx > 0.66 ? 'right' : 'center'
  const row = fy < 0.34 ? 'top' : fy > 0.66 ? 'bottom' : 'middle'
  if (row === 'middle' && col === 'center') return 'center'
  if (row === 'middle') return col
  if (col === 'center') return row
  return `${row}-${col}`
}

interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

function boardBounds(boards: AppModelBoard[]): Bounds | null {
  const placed = boards.filter((b) => b.x !== undefined && b.y !== undefined)
  if (placed.length === 0) return null
  const x0 = Math.min(...placed.map((b) => b.x as number))
  const y0 = Math.min(...placed.map((b) => b.y as number))
  const x1 = Math.max(...placed.map((b) => (b.x as number) + (b.w ?? 0)))
  const y1 = Math.max(...placed.map((b) => (b.y as number) + (b.h ?? 0)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * One line per board: `- [id8] type "title" · status · region · group:Name`. Groups listed
 * once at the top. null model (MCP not yet booted / no project open) → null: the caller
 * simply omits the Workspace system block.
 */
export function buildWorkspaceManifest(model: AppModel | null): string | null {
  if (!model) return null
  const boards = model.canvas.boards
  if (boards.length === 0) return 'The canvas is empty — no boards yet.'
  const groupOf = new Map<string, string>()
  for (const g of model.canvas.groups) {
    for (const id of g.boardIds) groupOf.set(id, g.name)
  }
  const bounds = boardBounds(boards)
  const shown = boards.slice(0, MANIFEST_MAX_BOARDS)
  const lines = shown.map((b) => {
    const parts = [`- [${b.id.slice(0, 8)}] ${b.type} "${clip(b.title, TITLE_MAX)}"`, b.status]
    const region = regionOf(b, bounds)
    if (region) parts.push(region)
    const group = groupOf.get(b.id)
    if (group) parts.push(`group:${clip(group, 24)}`)
    return parts.join(' · ')
  })
  const head = `Boards (${boards.length}${boards.length > shown.length ? `, showing ${shown.length}` : ''}):`
  const groups =
    model.canvas.groups.length > 0
      ? `Groups: ${model.canvas.groups.map((g) => `${clip(g.name, 24)}(${g.boardIds.length})`).join(', ')}`
      : null
  return [head, ...lines, ...(groups ? [groups] : [])].join('\n')
}

/**
 * Auto-tidy layout — pure, deterministic board packing (no React, no Zustand).
 *
 * Three modes, picked from the Tidy menu (default `smart`):
 *
 * - **smart** (link-aware) — the bake-off winner. Groups each Browser preview with the
 *   Terminal that drives it (`previewSourceId`): browsers fan out in a row, their source
 *   terminal sits centered in the terminal row directly beneath, standalone terminals
 *   flank it, planning boards trail. Rows are centered on the widest row. Reads the link
 *   graph, so it produces "AI-quality" grouping with zero model cost — and unlike an LLM
 *   it is deterministic and never mis-reports itself (see docs/feature-proposals.md SA-1).
 * - **by-type** — columns: terminals | browsers | planning, each stacked, tops aligned.
 * - **grid** — naive shelf bin-packing by reading order toward a target aspect. The dumb
 *   baseline; ignores type and links. Kept as a preset for flat, same-size canvases.
 *
 * All modes: pure, deterministic (stable sort, id tie-break, no randomness), reposition-
 * only (w/h untouched), non-overlapping, anchored at the cluster's current top-left so the
 * camera doesn't teleport. Fewer than 2 boards is a no-op. Safe for undo/redo + persistence.
 */

export type TidyMode = 'smart' | 'by-type' | 'grid'

/** Board fields the packer reads. `type`/`viewport`/`previewSourceId` drive smart + by-type;
 *  grid needs only the geometry, so they are optional. */
export interface TidyBoard {
  id: string
  x: number
  y: number
  w: number
  h: number
  type?: 'terminal' | 'browser' | 'planning' | 'command'
  viewport?: 'mobile' | 'tablet' | 'desktop'
  previewSourceId?: string | null
}

export interface TidyOptions {
  /** Which layout to produce. Default `smart`. */
  mode?: TidyMode
  /** Uniform gap (world px) between boards and rows/columns. Default `TIDY_GAP`. */
  gap?: number
  /** Target width / height ratio for `grid` mode (pass the viewport aspect). Ignored by
   *  smart/by-type. Non-positive or absent → `DEFAULT_ASPECT`. */
  aspect?: number
}

/** A new top-left for one board (w/h are unchanged by tidy). */
export interface TidyPlacement {
  id: string
  x: number
  y: number
}

/** Gap between tidied boards — matches the store's PLACE_GAP so tidy and auto-place agree. */
export const TIDY_GAP = 28
/** Fallback aspect when none is supplied (a typical wide pane). */
export const DEFAULT_ASPECT = 16 / 10

/** Stable id comparator (total order) — keeps every mode reproducible. */
const byId = (a: TidyBoard, b: TidyBoard): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Viewport display order for a browser row: widest first (desktop → tablet → mobile). */
const VIEWPORT_ORDER: Record<string, number> = { desktop: 0, tablet: 1, mobile: 2 }
const sortBrowsers = (bs: TidyBoard[]): TidyBoard[] =>
  [...bs].sort(
    (a, b) =>
      (VIEWPORT_ORDER[a.viewport ?? ''] ?? 3) - (VIEWPORT_ORDER[b.viewport ?? ''] ?? 3) ||
      byId(a, b)
  )

/** Lay a row of boards left→right from (startX, y); returns placements + the row's width/height. */
function packRow(
  row: TidyBoard[],
  gap: number,
  startX: number,
  y: number
): { placements: TidyPlacement[]; width: number; height: number } {
  const placements: TidyPlacement[] = []
  let x = startX
  let height = 0
  for (const b of row) {
    placements.push({ id: b.id, x, y })
    x += b.w + gap
    height = Math.max(height, b.h)
  }
  const width = row.length ? x - startX - gap : 0
  return { placements, width, height }
}

/** Stack `rows` top→bottom from (originX, originY), each row horizontally CENTERED on the
 *  widest row. The shape behind smart + the centering the bake-off judges asked for. */
function stackCenteredRows(
  rows: TidyBoard[][],
  gap: number,
  originX: number,
  originY: number
): TidyPlacement[] {
  const widths = rows.map((r) => r.reduce((s, b) => s + b.w, 0) + gap * Math.max(0, r.length - 1))
  // Linear scan instead of Math.max(...spread) — avoids V8's argument-count ceiling on large sets.
  let maxW = 0
  for (const w of widths) if (w > maxW) maxW = w
  const out: TidyPlacement[] = []
  let y = originY
  rows.forEach((row, i) => {
    const startX = originX + (maxW - widths[i]) / 2
    const { placements, height } = packRow(row, gap, startX, y)
    out.push(...placements)
    y += height + gap
  })
  return out
}

/**
 * Smart (link-aware): browser rows on top (one row per preview cluster, widest viewport
 * first), then a single terminal row with the source terminal(s) centered among the
 * standalone ones, then loose browsers, then planning. Rows are centered → a single-cluster
 * canvas lands its source terminal exactly under the midpoint of its previews.
 */
function smartLayout(
  boards: TidyBoard[],
  gap: number,
  originX: number,
  originY: number
): TidyPlacement[] {
  const terminals = boards.filter((b) => b.type === 'terminal')
  const browsers = boards.filter((b) => b.type === 'browser')
  const planning = boards.filter((b) => b.type !== 'terminal' && b.type !== 'browser')
  const terminalIds = new Set(terminals.map((t) => t.id))

  // A terminal is a "source" iff some present browser links to it.
  const sourceIds = new Set(
    browsers.map((b) => b.previewSourceId).filter((id): id is string => !!id && terminalIds.has(id))
  )

  // Group linked browsers by their source; unlinked browsers go to a loose row.
  const linked = new Map<string, TidyBoard[]>()
  const looseBrowsers: TidyBoard[] = []
  for (const b of browsers) {
    const src = b.previewSourceId
    if (src && sourceIds.has(src)) linked.set(src, [...(linked.get(src) ?? []), b])
    else looseBrowsers.push(b)
  }

  const rows: TidyBoard[][] = []
  // One browser row per cluster (clusters ordered by source id → deterministic).
  for (const src of [...linked.keys()].sort()) rows.push(sortBrowsers(linked.get(src)!))

  // Terminal row: standalone terminals split around the source terminal(s) so sources land
  // in the middle (and, with one cluster + centered rows, directly under their previews).
  const looseTerms = terminals.filter((t) => !sourceIds.has(t.id)).sort(byId)
  const sourceTerms = terminals.filter((t) => sourceIds.has(t.id)).sort(byId)
  const half = Math.floor(looseTerms.length / 2)
  const termRow = [...looseTerms.slice(0, half), ...sourceTerms, ...looseTerms.slice(half)]
  if (termRow.length) rows.push(termRow)

  if (looseBrowsers.length) rows.push(sortBrowsers(looseBrowsers))
  if (planning.length) rows.push([...planning].sort(byId))

  return stackCenteredRows(rows, gap, originX, originY)
}

/** By-type: terminals | browsers | planning, each a vertical column, tops aligned. */
function byTypeLayout(
  boards: TidyBoard[],
  gap: number,
  originX: number,
  originY: number
): TidyPlacement[] {
  const columns = (['terminal', 'browser', 'planning'] as const)
    .map((t) =>
      boards
        .filter((b) =>
          t === 'planning' ? b.type !== 'terminal' && b.type !== 'browser' : b.type === t
        )
        .sort(byId)
    )
    .filter((col) => col.length)

  const out: TidyPlacement[] = []
  let x = originX
  for (const col of columns) {
    let y = originY
    let colW = 0
    for (const b of col) {
      out.push({ id: b.id, x, y })
      y += b.h + gap
      colW = Math.max(colW, b.w)
    }
    x += colW + gap
  }
  return out
}

/** Grid: naive shelf bin-pack by reading order toward `aspect`. Type/link-blind baseline. */
function gridLayout(
  boards: TidyBoard[],
  gap: number,
  aspect: number,
  originX: number,
  originY: number
): TidyPlacement[] {
  const sorted = [...boards].sort((a, b) => a.y - b.y || a.x - b.x || byId(a, b))
  const totalArea = boards.reduce((sum, b) => sum + b.w * b.h, 0)
  // Linear scan instead of Math.max(...spread) — avoids V8's argument-count ceiling on large sets.
  let maxW = 0
  for (const board of boards) if (board.w > maxW) maxW = board.w
  const targetW = Math.max(maxW, Math.sqrt(totalArea * aspect))

  const out: TidyPlacement[] = []
  let cursorX = originX
  let rowY = originY
  let rowH = 0
  let rowCount = 0
  for (const b of sorted) {
    if (rowCount > 0 && cursorX - originX + b.w > targetW) {
      rowY += rowH + gap
      cursorX = originX
      rowH = 0
      rowCount = 0
    }
    out.push({ id: b.id, x: cursorX, y: rowY })
    cursorX += b.w + gap
    rowH = Math.max(rowH, b.h)
    rowCount++
  }
  return out
}

/**
 * Repack `boards` into a tidy, non-overlapping block. Returns one placement per board
 * (same ids; sizes untouched). Fewer than 2 boards is a no-op (positions preserved).
 * Deterministic for any input ordering. `opts.mode` selects the layout (default `smart`).
 */
export function tidyLayout(boards: readonly TidyBoard[], opts: TidyOptions = {}): TidyPlacement[] {
  const mode = opts.mode ?? 'smart'
  // Clamp gap non-negative: a negative gap would advance the cursor by less than a
  // board's width and overlap same-row neighbours (every mode assumes gap ≥ 0).
  const gap = Math.max(0, opts.gap ?? TIDY_GAP)
  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : DEFAULT_ASPECT

  if (boards.length < 2) return boards.map((b) => ({ id: b.id, x: b.x, y: b.y }))

  // Anchor at the cluster's current top-left so tidy nudges, not teleports.
  // Linear scan instead of Math.min(...spread) — avoids V8's argument-count ceiling on large sets
  // (same hazard documented in boardGeometry.ts › boardsBounds).
  let originX = Infinity
  let originY = Infinity
  for (const board of boards) {
    if (board.x < originX) originX = board.x
    if (board.y < originY) originY = board.y
  }
  const list = [...boards]

  switch (mode) {
    case 'by-type':
      return byTypeLayout(list, gap, originX, originY)
    case 'grid':
      return gridLayout(list, gap, aspect, originX, originY)
    case 'smart':
    default:
      return smartLayout(list, gap, originX, originY)
  }
}

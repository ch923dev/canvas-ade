/**
 * Tiling layout — pure, deterministic, RESIZE-to-fill board packing (no React/Zustand).
 *
 * Unlike `tidyLayout` (which only repositions, keeping board sizes), tiling works like a
 * window manager / FancyZones: it carves a target `area` into zones and **resizes + moves**
 * every board to fill its zone edge-to-edge (minus a uniform gap). The caller fits the camera
 * to the result, so the tiled block fills the screen.
 *
 * Templates adapt to the board count N:
 * - `cols-2|3|4` — k equal columns (k clamped to N); boards distributed column-major, stacked
 *   and resized to fill each column.
 * - `main-sidebar` — the largest board takes a 62% main zone; the rest stack in a 38% sidebar.
 * - `grid` — a near-square grid (cols = ⌈√N⌉); the last row's cells widen to fill the row.
 *
 * Pure + deterministic (reading-order assignment, id tie-break). Returns FULL rects
 * ({id,x,y,w,h}); the store clamps w/h to the board minimum. Safe for undo/redo + persistence.
 */
import { TIDY_GAP } from './tidyLayout'
import { MIN_BOARD_SIZE } from './boardSchema'

export type TileTemplate = 'cols-2' | 'cols-3' | 'cols-4' | 'main-sidebar' | 'grid'

/** Board geometry the tiler reads (x/y for reading order, w/h to pick the `main` board). */
export interface TileBoard {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** A full tiled rect — tiling sets size as well as position. */
export interface TiledRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** The world-space region to tile into (the caller passes a pane-aspect block, then fits). */
export interface TileArea {
  x: number
  y: number
  w: number
  h: number
}

const byReading = (a: TileBoard, b: TileBoard): number =>
  a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** k equal columns (k clamped to N); boards fill each column, stacked + resized. */
function columns(ordered: TileBoard[], k: number, area: TileArea, gap: number): TiledRect[] {
  const cols = Math.min(k, ordered.length)
  // Clamp the cell size to the board minimum and use that SAME value as both the size and
  // the stride. Without this, a too-narrow area (or a tall column with many boards) yields a
  // sub-minimum / negative cell; the store would then clamp the SIZE up to the minimum while
  // the POSITION stride stayed sub-minimum → overlapping boards. Clamping here keeps position
  // and size consistent: when a zone can't fit the minimum, boards overflow the area rather
  // than overlap each other.
  const colW = Math.max(MIN_BOARD_SIZE.w, (area.w - (cols - 1) * gap) / cols)
  const base = Math.floor(ordered.length / cols)
  const rem = ordered.length % cols // first `rem` columns get one extra board

  const out: TiledRect[] = []
  let idx = 0
  for (let c = 0; c < cols; c++) {
    const count = base + (c < rem ? 1 : 0)
    const x = area.x + c * (colW + gap)
    const cellH = Math.max(MIN_BOARD_SIZE.h, (area.h - (count - 1) * gap) / count)
    for (let r = 0; r < count; r++) {
      const b = ordered[idx++]
      out.push({ id: b.id, x, y: area.y + r * (cellH + gap), w: colW, h: cellH })
    }
  }
  return out
}

/** Largest board = a 62% main zone; the rest stack in a 38% sidebar. */
function mainSidebar(boards: TileBoard[], area: TileArea, gap: number): TiledRect[] {
  if (boards.length === 1) return [{ id: boards[0].id, x: area.x, y: area.y, w: area.w, h: area.h }]
  const main = [...boards].sort((a, b) => b.w * b.h - a.w * a.h || (a.id < b.id ? -1 : 1))[0]
  const rest = boards.filter((b) => b.id !== main.id).sort(byReading)
  // Clamp every zone dim to the board minimum (see `columns`): keeps size == stride so a
  // small area / tall sidebar overflows rather than overlaps.
  const mainW = Math.max(MIN_BOARD_SIZE.w, (area.w - gap) * 0.62)
  const sideW = Math.max(MIN_BOARD_SIZE.w, area.w - gap - mainW)
  const mainH = Math.max(MIN_BOARD_SIZE.h, area.h)
  const out: TiledRect[] = [{ id: main.id, x: area.x, y: area.y, w: mainW, h: mainH }]
  const m = rest.length
  const cellH = Math.max(MIN_BOARD_SIZE.h, (area.h - (m - 1) * gap) / m)
  const sx = area.x + mainW + gap
  rest.forEach((b, i) =>
    out.push({ id: b.id, x: sx, y: area.y + i * (cellH + gap), w: sideW, h: cellH })
  )
  return out
}

/** Near-square grid; the final (possibly short) row widens its cells to fill the width. */
function grid(ordered: TileBoard[], area: TileArea, gap: number): TiledRect[] {
  const n = ordered.length
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  // Clamp cell dims to the board minimum (see `columns`) so size == stride.
  const cellH = Math.max(MIN_BOARD_SIZE.h, (area.h - (rows - 1) * gap) / rows)
  const out: TiledRect[] = []
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols)
    const rowStart = r * cols
    const rowCount = Math.min(cols, n - rowStart) // last row may be short → wider cells
    const cellW = Math.max(MIN_BOARD_SIZE.w, (area.w - (rowCount - 1) * gap) / rowCount)
    const c = i - rowStart
    out.push({
      id: ordered[i].id,
      x: area.x + c * (cellW + gap),
      y: area.y + r * (cellH + gap),
      w: cellW,
      h: cellH
    })
  }
  return out
}

/**
 * Tile `boards` into `area` with `template`, resizing each to fill its zone. Returns one full
 * rect per board (same ids). Empty input → empty output; a single board fills the whole area.
 */
export function tileLayout(
  boards: readonly TileBoard[],
  template: TileTemplate,
  area: TileArea,
  gap: number = TIDY_GAP
): TiledRect[] {
  if (boards.length === 0) return []
  if (boards.length === 1) return [{ id: boards[0].id, x: area.x, y: area.y, w: area.w, h: area.h }]

  const ordered = [...boards].sort(byReading)
  switch (template) {
    case 'cols-2':
      return columns(ordered, 2, area, gap)
    case 'cols-3':
      return columns(ordered, 3, area, gap)
    case 'cols-4':
      return columns(ordered, 4, area, gap)
    case 'main-sidebar':
      return mainSidebar([...boards], area, gap)
    case 'grid':
    default:
      return grid(ordered, area, gap)
  }
}

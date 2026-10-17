/**
 * Role-aware tidy templates (spatial-awareness C10) — the CONSTANTS and template trees behind
 * `roleLayout` (ROLE-LAYOUT.md §4–§5), exported so the golden fixtures (§7) assert against the
 * very numbers the engine uses. Pure data + tiny tree builders: no React, no DOM, no store.
 *
 * A template is a small SPLIT TREE: a split lays its kids side by side along one axis (`x` =
 * columns, `y` = rows) and shares its length between them (`roleSizing.distribute`); a leaf is
 * one board. Every template is a list of VARIANTS in overflow order (ROLE-LAYOUT §6 step 1:
 * "the next denser template"): the engine keeps the first variant that stays readable.
 */
import { MIN_BOARD_SIZE } from './boardDefaults'
import { TIDY_GAP } from './tidyLayout'

/** In-unit gap between slots (world px) — the same gap tidy / fit use (`TIDY_GAP`). */
export const ROLE_GAP = TIDY_GAP

// ── Terminal readable minimum (ROLE-LAYOUT §5, MEASURED) ─────────────────────────────────────
// §5 proposed 480×300 for "≈60 cols × 14 rows at the default font". Measured against the code:
//  - font: `DEFAULT_TERMINAL_FONT` 12.5 px (canvas/boards/terminal/terminalFont.ts), xterm
//    `lineHeight: 1.2` (terminal/useTerminalSpawn.ts › new Terminal), default family stack
//    `--term-mono` = 'Cascadia Mono', Consolas, 'SF Mono', Menlo (styles/tokens.css).
//  - cell height: xterm 6 `DomRenderer._updateDimensions` → char h = ceil(measured line box) and
//    cell h = floor(char h × lineHeight). Cascadia Mono's line box is (1900 + 480) / 2048 =
//    1.162 em (Consolas ≈ 1.17) → ceil(12.5 × 1.162 = 14.5) = 15 → floor(15 × 1.2) = 18 px.
//  - cell width: monospace advance ≈ 0.6 em (Cascadia Mono 0.586, SF Mono / Menlo 0.60–0.61) →
//    7.5 px at 12.5 px — the wider macOS faces set the floor so 60 columns fit on every OS.
//  - chrome: title bar 34 (`--titlebar-h`), the 1 px board border on each side, the xterm host's
//    12 px padding on each side (terminalBoardStyles.screen) and the 14 px scrollbar gutter
//    FitAddon reserves (xterm `ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH`).
//  ⇒ w = 60 × 7.5 + 2×12 + 14 + 2×1 = 490 · h = 14 × 18 + 34 + 2×12 + 2×1 = 312.
// The proposal undershot by one row (300 px holds 13 rows) and ~1 column on macOS.
/** Pinned to `DEFAULT_TERMINAL_FONT` by a parity test. */
export const TERMINAL_FONT_PX = 12.5
/** xterm `lineHeight` option (useTerminalSpawn). */
export const TERMINAL_LINE_HEIGHT = 1.2
/** Default mono face's line box in em (Cascadia Mono ascender + descender / unitsPerEm). */
export const TERMINAL_LINE_BOX_EM = 1.162
/** Monospace glyph advance in em (the widest common default face). */
export const TERMINAL_ADVANCE_EM = 0.6
export const TERMINAL_CELL_H = Math.floor(
  Math.ceil(TERMINAL_FONT_PX * TERMINAL_LINE_BOX_EM) * TERMINAL_LINE_HEIGHT
)
export const TERMINAL_CELL_W = TERMINAL_FONT_PX * TERMINAL_ADVANCE_EM
export const TERMINAL_READABLE_COLS = 60
export const TERMINAL_READABLE_ROWS = 14
/** Board title bar (`--titlebar-h`; pinned to browserLayout.TITLEBAR_H by a parity test). */
export const BOARD_TITLEBAR_H = 34
export const BOARD_BORDER_PX = 1
/** xterm host padding on each side (terminalBoardStyles.screen). */
export const TERMINAL_WELL_PAD = 12
/** Scrollbar gutter FitAddon subtracts (xterm DEFAULT_SCROLL_BAR_WIDTH). */
export const XTERM_SCROLLBAR_W = 14

/** Smallest terminal board that still shows 60 × 14 cells at the default font: 490 × 312. */
export const TERMINAL_MIN: Readonly<{ w: number; h: number }> = Object.freeze({
  w: Math.ceil(
    TERMINAL_READABLE_COLS * TERMINAL_CELL_W +
      2 * TERMINAL_WELL_PAD +
      XTERM_SCROLLBAR_W +
      2 * BOARD_BORDER_PX
  ),
  h:
    TERMINAL_READABLE_ROWS * TERMINAL_CELL_H +
    BOARD_TITLEBAR_H +
    2 * TERMINAL_WELL_PAD +
    2 * BOARD_BORDER_PX
})

/** Every other flexible board (swarm, command, dataflow) floors at the board minimum. */
export const FLEX_MIN: Readonly<{ w: number; h: number }> = MIN_BOARD_SIZE

// ── Template thresholds (pane aspect A = pane.w / pane.h, ROLE-LAYOUT §4) ────────────────────
/** `hero-rail` from here up; `hero-strip` below. */
export const HERO_RAIL_MIN_ASPECT = 1.3
/** `duo-rail` for ≥ 2 preview co-heroes from here up; `duo-strip` below. */
export const DUO_RAIL_MIN_ASPECT = 1.6
/** Ultrawide: hero at 45 % + a 2-column rail; `pair` becomes agent | preview | rail. */
export const ULTRAWIDE_MIN_ASPECT = 2.2

/** Hero shares of the split they sit in (ROLE-LAYOUT §4). Applied to a FLEXIBLE hero only — a
 *  rigid hero wraps its size, an aspect-locked hero takes its device aspect (§5). */
export const HERO_SHARE = Object.freeze({
  /** `hero-rail`, 1-column rail. */
  rail: 0.62,
  /** `hero-rail`, 2-column rail (4–6 others, and the `+strip` fallback). */
  rail2: 0.5,
  /** Ultrawide `hero-rail`. */
  ultrawide: 0.45,
  /** `hero-strip`: the hero's share of the height. */
  strip: 0.65,
  /** `duo-strip`: the co-heroes' band share of the height. */
  duo: 0.7
})

/** Cells a 1-column rail holds before the rail goes 2 columns. */
export const RAIL_ONE_COL_MAX = 3
/** Cells a 2-column rail holds before a bottom strip is added. */
export const RAIL_TWO_COL_MAX = 6
/** The denser `+strip` fallback for 5–6 others keeps 4 cells in the rail. */
export const RAIL_DENSE_MAX = 4
/** Cells per strip row. */
export const STRIP_ROW_MAX = 4
/** Height share of the bottom strip under `hero-rail/2-col+strip`. */
export const BOTTOM_STRIP_SHARE = 0.3
/** `duo-rail`: the rail's stretch weight against 1 per co-hero (≈ the 62 / 38 hero split). */
export const COHERO_RAIL_WEIGHT = 0.6
/** Compact (off-stage) units are solved like the stage but may sit tighter than 100 %. */
export const COMPACT_MAX_ZOOM = 2
/** `targetZoom` is floored to this step so the frame never undershoots a minimum. */
export const ZOOM_STEP = 1e-4

// ── Template trees ─────────────────────────────────────────────────────────────────────────────
export type Axis = 'x' | 'y'
/** How the engine may size a board (ROLE-LAYOUT §5, D7). */
export type SizeClass = 'flexible' | 'aspect' | 'rigid'

/** One board as a template slot sees it. All floors are whole px. */
export interface Member {
  id: string
  cls: SizeClass
  /** Current size (rigid keeps it exactly; aspect keeps its ratio). */
  w: number
  h: number
  /** Floors per axis: role minimum (flexible), ceil'd size (rigid), board minimum at the
   *  board's own aspect (aspect). */
  minW: number
  minH: number
}

export type LNode =
  | { kind: 'leaf'; m: Member }
  | {
      kind: 'split'
      axis: Axis
      kids: LNode[]
      /** Stretch weights, one per kid. */
      weights: number[]
      /** Kid 0 is the hero region: when it stretches it must get ≥ this share (soft). */
      share?: number
    }

export interface Variant {
  /** `hero-rail`, `hero-rail/2-col`, `hero-strip/2-row`, … — reported as `units[].template`. */
  name: string
  root: LNode
}

const leaf = (m: Member): LNode => ({ kind: 'leaf', m })

function split(axis: Axis, kids: LNode[], weights?: number[], share?: number): LNode {
  if (kids.length === 1) return kids[0]
  const node: LNode = { kind: 'split', axis, kids, weights: weights ?? kids.map(() => 1) }
  if (share !== undefined) node.share = share
  return node
}

/** `ms` as rows of ≤ `perRow` cells, row-major (S2: w1 w2 / w3 w4 / w5 w6). */
function rows(ms: readonly Member[], perRow: number): LNode {
  const out: LNode[] = []
  for (let i = 0; i < ms.length; i += perRow) {
    out.push(split('x', ms.slice(i, i + perRow).map(leaf)))
  }
  return split('y', out)
}

/** The hero region: one leaf, or co-heroes side by side. */
const heroNode = (heroes: readonly Member[]): LNode => split('x', heroes.map(leaf))

function heroRail(
  heroes: readonly Member[],
  others: readonly Member[],
  railCols: number,
  railMax: number,
  share: number
): Variant {
  const railMs = others.slice(0, railMax)
  const stripMs = others.slice(railMax)
  const rail = railCols === 1 ? split('y', railMs.map(leaf)) : rows(railMs, railCols)
  const top = split('x', [heroNode(heroes), rail], [share, 1 - share], share)
  const name = `hero-rail${railCols > 1 ? '/2-col' : ''}${stripMs.length > 0 ? '+strip' : ''}`
  if (stripMs.length === 0) return { name, root: top }
  const strip = rows(stripMs, STRIP_ROW_MAX)
  return {
    name,
    root: split('y', [top, strip], [1 - BOTTOM_STRIP_SHARE, BOTTOM_STRIP_SHARE])
  }
}

/**
 * `hero-rail` (A ≥ 1.3): hero 62 % + a rail of ≤ 3 stacked cells; 4–6 others → 2-column rail
 * at 50 %; more → + a bottom strip. Ultrawide (A ≥ 2.2): hero 45 % + a 2-column rail.
 * Overflow order: 1-col → 2-col → 2-col + strip.
 */
export function heroRailVariants(
  heroes: readonly Member[],
  others: readonly Member[],
  aspect: number
): Variant[] {
  const k = others.length
  if (k === 0) return [{ name: 'hero-rail', root: heroNode(heroes) }]
  const ultra = aspect >= ULTRAWIDE_MIN_ASPECT
  const twoShare = ultra ? HERO_SHARE.ultrawide : HERO_SHARE.rail2
  const out: Variant[] = []
  if (!ultra && k <= RAIL_ONE_COL_MAX) {
    out.push(heroRail(heroes, others, 1, RAIL_ONE_COL_MAX, HERO_SHARE.rail))
  }
  if (k <= RAIL_TWO_COL_MAX && (ultra || k >= 2)) {
    out.push(heroRail(heroes, others, k === 1 ? 1 : 2, RAIL_TWO_COL_MAX, twoShare))
  }
  const denseMax = k > RAIL_TWO_COL_MAX ? RAIL_TWO_COL_MAX : RAIL_DENSE_MAX
  if (k > denseMax) out.push(heroRail(heroes, others, 2, denseMax, twoShare))
  return out
}

/** Strip row counts to try for `k` cells: 1 row up to 4 cells, else 2, then denser. */
function stripRowCounts(k: number): number[] {
  const out: number[] = []
  const first = k <= STRIP_ROW_MAX ? 1 : 2
  for (let r = first; r <= Math.min(k, first + 2); r++) {
    const actual = Math.ceil(k / Math.ceil(k / r))
    if (!out.includes(actual)) out.push(actual)
  }
  return out
}

function bandOverStrip(
  base: string,
  band: LNode,
  others: readonly Member[],
  share: number
): Variant[] {
  if (others.length === 0) return [{ name: base, root: band }]
  return stripRowCounts(others.length).map((r) => ({
    name: r === 1 ? base : `${base}/${r}-row`,
    root: split('y', [band, rows(others, Math.ceil(others.length / r))], [share, 1 - share], share)
  }))
}

/** `hero-strip` (A < 1.3): the hero on top at 65 %, a strip of ≤ 4 cells below, or 2+ rows. */
export function heroStripVariants(heroes: readonly Member[], others: readonly Member[]): Variant[] {
  return bandOverStrip('hero-strip', heroNode(heroes), others, HERO_SHARE.strip)
}

/** `duo-strip`: co-heroes share the top 70 % (widths by their aspect needs), the rest below. */
export function duoStripVariants(heroes: readonly Member[], others: readonly Member[]): Variant[] {
  return bandOverStrip('duo-strip', heroNode(heroes), others, HERO_SHARE.duo)
}

/** `duo-rail` (A ≥ 1.6 with ≥ 2 preview co-heroes; ultrawide `pair`): co-heroes side by side,
 *  a rail on the right — 1 column up to 3 cells, then 2, then 3. */
export function duoRailVariants(heroes: readonly Member[], others: readonly Member[]): Variant[] {
  const k = others.length
  if (k === 0) return [{ name: 'duo-rail', root: heroNode(heroes) }]
  const out: Variant[] = []
  const first = k <= RAIL_ONE_COL_MAX ? 1 : 2
  for (let c = first; c <= Math.min(k, first + 1); c++) {
    const rail = c === 1 ? split('y', others.map(leaf)) : rows(others, c)
    out.push({
      name: c === 1 ? 'duo-rail' : `duo-rail/${c}-col`,
      root: split('x', [...heroes.map(leaf), rail], [...heroes.map(() => 1), COHERO_RAIL_WEIGHT])
    })
  }
  return out
}

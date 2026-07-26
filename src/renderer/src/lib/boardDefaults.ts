/**
 * Per-type board size/title defaults — a LEAF module extracted from `boardSchema.ts` at the v23
 * max-lines ratchet (the kanbanSchema/terminalBoardSchema precedent). The back-reference to
 * `BoardType` is type-only, so there is no runtime import cycle; `boardSchema.ts` re-exports the
 * public constants so every existing `import { DEFAULT_BOARD_SIZE } from '.../boardSchema'`
 * consumer is unchanged.
 */
import type { BoardType } from './boardSchema'

/** Smallest a board may be resized to (DESIGN.md §6). */
export const MIN_BOARD_SIZE = { w: 240, h: 160 } as const

/** Size a freshly-added board of each type gets (handoff 2.0-B). */
export const DEFAULT_BOARD_SIZE: Record<BoardType, { w: number; h: number }> = {
  terminal: { w: 420, h: 340 },
  browser: { w: 700, h: 500 },
  planning: { w: 516, h: 366 },
  // Wide enough for the five-column kanban body + the submit well + worker-pool strip (the
  // approved Phase-A production mock); collapses to a one-line rail when minimized.
  command: { w: 760, h: 440 },
  file: { w: 520, h: 380 },
  // Wide enough for the focus-on-node graph + the bottom legend strip (the approved JD-4 mock).
  dataflow: { w: 760, h: 520 },
  // Wide enough for the four default columns side by side + a little header room (the P4 mock).
  kanban: { w: 900, h: 520 },
  // Big by default (07 §3): chat spine + worker-card canvas + needs-you strip side by side (the
  // signed-off S1 design artifact frame).
  swarm: { w: 1180, h: 660 }
}

export const DEFAULT_TITLE: Record<BoardType, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  planning: 'Planning',
  command: 'Orchestrator',
  file: 'File',
  dataflow: 'Data Flow',
  kanban: 'Kanban',
  swarm: 'Swarm'
}

/** Seed URL for a new Browser board (basic edit lands in 2.2; port assignment Phase 3). */
export const DEFAULT_BROWSER_URL = 'http://localhost:5173'

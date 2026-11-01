/**
 * Layout slice (spatial-awareness I2) — `applyLayout`: land ONE arrangement computed by the tidy
 * engine (`store/spatialTidy.ts` — fit / roles / tile / the legacy packers) as ONE tracked undo
 * step. x/y always; w/h only where a placement carries them (the engines never size a rigid
 * board), clamped to the board minimum like `resizeBoard` / `tileBoards`. Docked worker terminals
 * and unknown ids are skipped — the engine never emits them; this is defence in depth.
 */
import { isDockedTerminal, type Board } from '../../lib/boardSchema'
import { MIN_BOARD_SIZE } from '../../lib/boardDefaults'
import type { GetCanvasState, SetCanvasState, SliceDeps } from './sliceTypes'

/** One board's new top-left, plus a new size when the engine sized it. */
export interface LayoutPlacement {
  id: string
  x: number
  y: number
  w?: number
  h?: number
}

export interface LayoutSliceState {
  /**
   * Apply `placements` as ONE undo step (none when nothing changed). Returns how many boards
   * moved or resized — the `tidy_canvas` ack's `moved`.
   */
  applyLayout: (placements: readonly LayoutPlacement[]) => number
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Pure core of {@link LayoutSliceState.applyLayout}: the next board array (or null when nothing
 * changed) and the changed count. A non-finite coordinate skips that placement; a non-finite or
 * non-positive size keeps the board's own.
 */
export function applyPlacements(
  boards: Board[],
  placements: readonly LayoutPlacement[]
): { boards: Board[] | null; moved: number } {
  const byId = new Map<string, LayoutPlacement>()
  for (const p of placements) if (finite(p.x) && finite(p.y)) byId.set(p.id, p)
  let moved = 0
  const next = boards.map((b) => {
    const p = byId.get(b.id)
    if (!p || isDockedTerminal(b)) return b
    const w = finite(p.w) && p.w > 0 ? Math.max(MIN_BOARD_SIZE.w, p.w) : b.w
    const h = finite(p.h) && p.h > 0 ? Math.max(MIN_BOARD_SIZE.h, p.h) : b.h
    if (b.x === p.x && b.y === p.y && b.w === w && b.h === h) return b
    moved++
    return { ...b, x: p.x, y: p.y, w, h }
  })
  return { boards: moved > 0 ? next : null, moved }
}

export function createLayoutSlice(
  set: SetCanvasState,
  _get: GetCanvasState,
  deps: Pick<SliceDeps, 'trackedChange'>
): LayoutSliceState {
  const { trackedChange } = deps
  return {
    applyLayout: (placements) => {
      let moved = 0
      set((s) => {
        const next = applyPlacements(s.boards, placements)
        moved = next.moved
        // Bulk layout op (the tidy/tile precedent): one checkpoint of the pre-tidy present.
        return trackedChange(s, next.boards ? { boards: next.boards } : null, {
          reflectPresent: true
        })
      })
      return moved
    }
  }
}

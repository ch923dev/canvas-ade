/**
 * Vector-layer view derivation (PLAN-07) — extracted VERBATIM from PlanningBoard so the board
 * file stays under its max-lines ratchet (the offset that pays for the P3 PlanningInspector
 * portal wiring). Pure derivation from the store elements + the transient drag/erase state:
 * keeps the viewElements / arrows / strokes arrays referentially STABLE across re-renders that
 * don't touch those inputs, so the React.memo'd WhiteboardSvg + cards can actually skip.
 */
import { useMemo } from 'react'
import type { ArrowElement, PlanningElement, StrokeElement } from '../../../lib/boardSchema'
import { translateMany } from './elements'

export interface PlanningViewElements {
  viewElements: PlanningElement[]
  arrows: ArrowElement[]
  strokes: StrokeElement[]
}

export function usePlanningViewElements({
  elements,
  dragPos,
  pendingErase
}: {
  elements: PlanningElement[]
  dragPos: { ids: string[]; dx: number; dy: number; alt: boolean } | null
  pendingErase: Set<string> | null
}): PlanningViewElements {
  // The render-time element list, memoized on its only real inputs (the store elements +
  // the transient drag/erase state). Memoizing it (PLAN-07) keeps a STABLE reference across
  // re-renders that don't touch those inputs — an editingTextId / snap / hover change — so
  // the downstream arrows/strokes memos (and the React.memo'd WhiteboardSvg) can actually
  // skip. When idle it returns the store's own `elements` array by reference (no per-render
  // allocation), preserving the prior behavior the memo'd cards already relied on.
  const viewElements = useMemo<PlanningElement[]>(() => {
    // While a move is in flight, render the dragged element shifted by its transient delta
    // (the store still holds the pre-drag position until pointer-up — #9). Any kind is
    // movable (cards + arrows + strokes), so the SVG vectors derive from this too (#28, #37).
    const movedView = dragPos ? translateMany(elements, dragPos.ids, dragPos.dx, dragPos.dy) : null
    // During a normal move the originals shift; during an ALT drag the originals stay put and
    // translated GHOST copies (temporary `__ghost__` ids, NEVER committed) preview the
    // duplicate. The captured pointer means onSelect/onDragStart never fire on a ghost, and
    // its id is dropped the instant the alt-drag ends.
    const ghostCopies =
      dragPos && dragPos.alt && movedView
        ? movedView
            .filter((e) => dragPos.ids.includes(e.id))
            .map((e) => ({ ...e, id: `__ghost__${e.id}` }) as PlanningElement)
        : []
    const baseView =
      dragPos && !dragPos.alt && movedView
        ? movedView
        : pendingErase && pendingErase.size > 0
          ? elements.filter((el) => !pendingErase.has(el.id))
          : elements
    return ghostCopies.length > 0 ? [...baseView, ...ghostCopies] : baseView
  }, [elements, dragPos, pendingErase])

  // PLAN-07: keep the vector-layer arrays referentially stable across re-renders that
  // don't change the well content (keyed on the memoized viewElements) so the React.memo'd
  // WhiteboardSvg can skip a note keystroke / snap toggle / editing-state re-render.
  const arrows = useMemo(
    () => viewElements.filter((e): e is ArrowElement => e.kind === 'arrow'),
    [viewElements]
  )
  const strokes = useMemo(
    () => viewElements.filter((e): e is StrokeElement => e.kind === 'stroke'),
    [viewElements]
  )

  return { viewElements, arrows, strokes }
}

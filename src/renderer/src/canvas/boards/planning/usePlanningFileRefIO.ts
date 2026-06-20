/**
 * Planning file-reference drop (file-tree S4). The docked tree's rows are native drag sources that
 * carry a `FILEREF_MIME` payload (`{path,label}` JSON); dropping one on a Planning board drops a
 * `fileref` chip element at the cursor. Mirrors `usePlanningImageIO`'s two drag handlers so the two
 * can be composed onto the single well `onDrop`/`onDragOver` (the board tries the file-ref MIME
 * first, then falls back to image files).
 *
 * Like the image path, the commit RE-READS the live elements at commit time rather than spreading a
 * render-time closure: `updateBoard` replaces `elements` wholesale, so a concurrent edit must not be
 * clobbered. There is no async window here (no asset write), but the discipline is kept identical so
 * the two drop pipelines behave the same.
 */
import { useCallback, type DragEvent as ReactDragEvent } from 'react'
import type { PlanningBoard as PlanningBoardData, PlanningElement } from '../../../lib/boardSchema'
import { useCanvasStore } from '../../../store/canvasStore'
import { FILEREF_MIME } from '../../fileTreeData'
import { makeFileRef } from './elements'

const newId = (): string => crypto.randomUUID()

/** Basename of a forward-slashed relative path (fallback label when the payload omits one). */
function basename(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

interface PlanningFileRefIODeps {
  toBoard: (e: { clientX: number; clientY: number }) => { x: number; y: number }
  commit: (next: PlanningElement[] | ((current: PlanningElement[]) => PlanningElement[])) => void
  beginChange: () => void
  board: PlanningBoardData
}

export function usePlanningFileRefIO(deps: PlanningFileRefIODeps): {
  onWellDragOver: (e: ReactDragEvent) => void
  onWellDrop: (e: ReactDragEvent) => void
} {
  const { toBoard, commit, beginChange, board } = deps

  /** Accept a file-ref drag over the well (required for onDrop to fire). `getData` is blocked during
   *  dragover for privacy, so gate on `types` — the MIME is always present in the type list.
   *  stopPropagation keeps the canvas-level file glue (`useCanvasFileGlue`) from ALSO claiming the
   *  drag — exactly the discipline a File board uses for a drop onto itself. */
  const onWellDragOver = useCallback((e: ReactDragEvent): void => {
    if (!e.dataTransfer?.types?.includes(FILEREF_MIME)) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  /** Drop a tree file-ref → a chip at the cursor (board-local). No-op (no preventDefault) when the
   *  drop carries no file-ref payload, so the board's image-drop fallback still runs. stopPropagation
   *  prevents the canvas drop handler from ALSO opening a File board behind the chip (the documented
   *  "a board claims the drop, the canvas never sees it" rule in useCanvasFileGlue). */
  const onWellDrop = useCallback(
    (e: ReactDragEvent): void => {
      const raw = e.dataTransfer?.getData(FILEREF_MIME)
      if (!raw) return
      e.preventDefault()
      e.stopPropagation()
      let path = ''
      let label = ''
      try {
        const payload = JSON.parse(raw) as { path?: unknown; label?: unknown }
        if (typeof payload.path === 'string') path = payload.path
        if (typeof payload.label === 'string') label = payload.label
      } catch {
        return // malformed payload — drop nothing rather than a broken element
      }
      if (!path) return
      const at = toBoard(e)
      beginChange()
      // Live-read at commit time (mirrors usePlanningImageIO): updateBoard fully replaces `elements`.
      const live = useCanvasStore.getState().boards.find((b) => b.id === board.id)
      const cur = live?.type === 'planning' ? live.elements : []
      commit([...cur, makeFileRef(newId(), at, path, label || basename(path))])
    },
    [toBoard, commit, beginChange, board.id]
  )

  return { onWellDragOver, onWellDrop }
}

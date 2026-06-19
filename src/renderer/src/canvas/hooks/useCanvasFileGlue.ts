/**
 * File-tree epic (S3) — the File-board wiring that needs the React Flow instance, so it can't
 * live in the store:
 *  1. CAMERA FOCUS ON OPEN — consumes the store's one-shot `pendingFocusId` (set by
 *     `openFileBoard` on the tree-click path) and runs the canonical `focusBoardById`
 *     (camera-fit + dim). Deferred one frame so a freshly-added board's RF node is registered
 *     before `fitView` reads it.
 *  2. CANVAS FILE DROP — a file-ref dragged out of the tree onto empty canvas opens as a new
 *     File board centred on the drop point. A drop ONTO an existing File board is handled by
 *     that board (which stops propagation), so it never reaches here.
 */
import { useCallback, useEffect, type DragEvent } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { DEFAULT_BOARD_SIZE } from '../../lib/boardSchema'
import { FILEREF_MIME } from '../fileTreeData'

interface FileGlue {
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}

export function useCanvasFileGlue(
  rf: ReactFlowInstance,
  focusBoardById: (id: string) => void
): FileGlue {
  const pendingFocusId = useCanvasStore((s) => s.pendingFocusId)

  useEffect(() => {
    if (!pendingFocusId) return
    // Defer one frame: a board opened this tick is in the store, but RF may not have registered
    // its node yet — an immediate fitView would find nothing. rAF lets the node mount first.
    const raf = requestAnimationFrame(() => {
      focusBoardById(pendingFocusId)
      useCanvasStore.setState({ pendingFocusId: null })
    })
    return () => cancelAnimationFrame(raf)
  }, [pendingFocusId, focusBoardById])

  const onDragOver = useCallback((e: DragEvent): void => {
    // Only claim the drop when it carries our file-ref payload (don't swallow other drags).
    if (!e.dataTransfer.types.includes(FILEREF_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent): void => {
      const raw = e.dataTransfer.getData(FILEREF_MIME)
      if (!raw) return
      e.preventDefault()
      let path = ''
      try {
        path = String(JSON.parse(raw).path ?? '')
      } catch {
        return
      }
      if (!path) return
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const size = DEFAULT_BOARD_SIZE.file
      useCanvasStore.getState().openFileBoard(path, { x: p.x - size.w / 2, y: p.y - size.h / 2 })
    },
    [rf]
  )

  return { onDragOver, onDrop }
}

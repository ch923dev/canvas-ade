/**
 * Drag-to-create board placement (redesign 2026-06-06). Armed ≡ the store `tool` is a
 * board type (the dock sets it; see AppChrome.Dock). While armed, Canvas renders a
 * transparent capture overlay whose `onPointerDown` is `startPlacement`:
 *   - drag ≥5px  → a board sized to the dragged rect (world coords, min-clamped), placed exact
 *   - click <5px → a default-size board centered on the cursor (freeSlot-nudged)
 * Either way the tool reverts to 'select'. Esc cancels. The ghost is a screen-space rect
 * (client coords) the overlay draws; world conversion happens only on release.
 *
 * Pointer model mirrors Canvas.tsx's connector rubber-band: pointerdown arms a window
 * pointermove/pointerup pair, removed on release (no per-frame store writes).
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { DEFAULT_BOARD_SIZE, type BoardType } from '../../lib/boardSchema'
import { isClickGesture, normalizeBox, placementRect, type Box } from '../../lib/placement'

export interface BoardPlacementApi {
  /** True while a board type is armed (capture overlay should mount). */
  armed: boolean
  /** Screen-space ghost rect (client coords) while dragging, else null. */
  ghost: Box | null
  /** Capture overlay's `onPointerDown`. */
  startPlacement: (e: ReactPointerEvent) => void
}

export function useBoardPlacement(rf: ReactFlowInstance): BoardPlacementApi {
  const tool = useCanvasStore((s) => s.tool)
  const setTool = useCanvasStore((s) => s.setTool)
  const armed = tool !== 'select'
  const [ghost, setGhost] = useState<Box | null>(null)

  // Esc cancels while armed.
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setGhost(null)
        setTool('select')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armed, setTool])

  const startPlacement = useCallback(
    (e: ReactPointerEvent) => {
      if (tool === 'select') return
      const type = tool as BoardType
      const sx = e.clientX
      const sy = e.clientY
      setGhost({ x: sx, y: sy, w: 0, h: 0 })

      const onMove = (ev: PointerEvent): void => {
        setGhost(normalizeBox(sx, sy, ev.clientX, ev.clientY))
      }
      const onUp = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setGhost(null)
        const add = useCanvasStore.getState().addBoard
        if (isClickGesture(ev.clientX - sx, ev.clientY - sy)) {
          const pt = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
          const size = DEFAULT_BOARD_SIZE[type]
          add(type, { x: pt.x - size.w / 2, y: pt.y - size.h / 2 }, { exact: false })
        } else {
          const a = rf.screenToFlowPosition({ x: Math.min(sx, ev.clientX), y: Math.min(sy, ev.clientY) })
          const b = rf.screenToFlowPosition({ x: Math.max(sx, ev.clientX), y: Math.max(sy, ev.clientY) })
          const r = placementRect(a, b)
          add(type, { x: r.x, y: r.y }, { size: { w: r.w, h: r.h }, exact: true })
        }
        setTool('select')
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [tool, rf, setTool]
  )

  return { armed, ghost, startPlacement }
}

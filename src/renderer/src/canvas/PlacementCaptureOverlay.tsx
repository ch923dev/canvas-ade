/**
 * The drag/place capture overlay (extracted from Canvas.tsx — file-size doctrine). While a dock
 * tool is armed, a transparent overlay (z-40) owns the pointer so boards go non-interactive and
 * React Flow can't pan. Drag tools (terminal/browser/planning) press→drag a rubber-band; the
 * Command board follows the cursor with a fixed-size ghost and a single click plants it. Chrome
 * (z-50) stays above this, so the dock buttons stay clickable to re-arm or cancel.
 */
import { type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { type BoardType } from '../lib/boardSchema'
import { TypeGlyph } from './TypeGlyph'
import type { BoardPlacementApi } from './hooks/useBoardPlacement'

export function PlacementCaptureOverlay({
  armed,
  placeMode,
  ghost,
  startPlacement,
  followMove,
  followPlace,
  cancelPlacement
}: BoardPlacementApi): ReactElement | null {
  const tool = useCanvasStore((s) => s.tool)
  if (!armed) return null
  const follow = placeMode === 'follow'
  return (
    <div
      className="placement-capture"
      onPointerDown={follow ? undefined : startPlacement}
      onPointerMove={follow ? followMove : undefined}
      onClick={follow ? followPlace : undefined}
      onContextMenu={
        follow
          ? (e): void => {
              e.preventDefault()
              cancelPlacement()
            }
          : undefined
      }
    >
      {ghost && (
        <div
          className="placement-ghost"
          style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}
        >
          <span className="placement-ghost-chip">
            <TypeGlyph type={tool as BoardType} />{' '}
            {tool === 'command' ? 'Orchestrator · click to place' : tool}
          </span>
        </div>
      )}
    </div>
  )
}

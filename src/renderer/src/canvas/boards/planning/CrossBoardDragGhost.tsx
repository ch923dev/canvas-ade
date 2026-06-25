/**
 * Canvas-level drag affordance for the Phase-4 cross-board drag (spec §3.C). A portal to
 * <body>, **`pointer-events: none`** (so it never blocks `document.elementFromPoint` — the
 * load-bearing hit-test — nor returns itself), screen-`fixed`, painted above every board.
 *
 * It renders three pieces, all driven by the source board's transient `crossBoardDrag`
 * state (no cross-board state needed — the dragging board owns this):
 *  - a faint **footprint outline** the size of the dragged selection's union bbox, offset so
 *    the grabbed point sits under the cursor (mirrors where the payload will land),
 *  - a **count chip** ("N items") at the cursor,
 *  - and, over a valid foreign Planning well, a **drop-target ring** at that well's rect.
 *
 * v1 is the outline + chip + ring (NOT full-fidelity card ghosts — the approved scope).
 */
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import type { CrossBoardDrag } from './usePlanningPointer'

export function CrossBoardDragGhost({ drag }: { drag: CrossBoardDrag }): ReactElement {
  const { cursor, count, ghost, target } = drag
  return createPortal(
    <div className="pl-xfer-layer" aria-hidden>
      {target && (
        <div
          className="pl-xfer-ring"
          style={{
            left: target.rect.left,
            top: target.rect.top,
            width: target.rect.width,
            height: target.rect.height
          }}
        />
      )}
      <div
        className="pl-xfer-ghost"
        style={{
          left: cursor.x - ghost.offsetX,
          top: cursor.y - ghost.offsetY,
          width: Math.max(8, ghost.w),
          height: Math.max(8, ghost.h)
        }}
      />
      <div className="pl-xfer-chip" style={{ left: cursor.x + 12, top: cursor.y + 14 }}>
        {count} item{count === 1 ? '' : 's'}
      </div>
    </div>,
    document.body
  )
}

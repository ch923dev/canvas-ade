/**
 * Draws one outline box per named group, framing its member boards with the name on a tab.
 * Mounted INSIDE <ReactFlow> (below the board nodes) so it rides the camera transform via the
 * React Flow viewport. Outline-only + interior pointer-events:none so boards/canvas underneath
 * stay interactive; only the name tab is a handle (S3/S5 wire its actions). Occlusion (ADR 0002):
 * a live Browser board's native view paints over box segments it overlaps at rest — accepted.
 */
import { useMemo, type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { computeGroupBoxes } from '../lib/groupBoxes'

/** World-px the box extends beyond member bounds (depth 0) + the per-nesting inset. */
export const GROUP_BOX_PAD = 20
export const GROUP_BOX_INSET_STEP = 12

export interface GroupBoxLayerProps {
  /** Single-click a tab = select all members; double-click = focus the group (S4/S5). */
  onTabClick?: (groupId: string) => void
  onTabDoubleClick?: (groupId: string) => void
}

export function GroupBoxLayer({ onTabClick, onTabDoubleClick }: GroupBoxLayerProps): ReactElement {
  const groups = useCanvasStore((s) => s.groups)
  const boards = useCanvasStore((s) => s.boards)
  const [tx, ty, zoom] = useStore((s) => s.transform)

  const boxes = useMemo(
    () =>
      computeGroupBoxes(groups, boards, { pad: GROUP_BOX_PAD, insetStep: GROUP_BOX_INSET_STEP }),
    [groups, boards]
  )

  return (
    <div
      className="group-box-layer"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        transform: `translate(${tx}px, ${ty}px) scale(${zoom})`,
        transformOrigin: '0 0',
        zIndex: 0
      }}
    >
      {boxes.map((b) => (
        <div
          key={b.id}
          className="group-box"
          style={{ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h }}
        >
          <button
            type="button"
            className="group-box-tab"
            style={{ pointerEvents: 'auto' }}
            onClick={() => onTabClick?.(b.id)}
            onDoubleClick={() => onTabDoubleClick?.(b.id)}
            title={b.name}
          >
            {b.name}
          </button>
        </div>
      ))}
    </div>
  )
}

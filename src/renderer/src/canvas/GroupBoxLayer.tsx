/**
 * Draws one outline box per named group, framing its member boards with the name on a tab.
 * Mounted INSIDE <ReactFlow> (below the board nodes) so it rides the camera transform via the
 * React Flow viewport. Outline-only + interior pointer-events:none so boards/canvas underneath
 * stay interactive; only the name tab is a handle (S3/S5 wire its actions). Occlusion (ADR 0002):
 * a live Browser board's native view paints over box segments it overlaps at rest — accepted.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import { useStore } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { computeGroupBoxes, groupMemberRectKey } from '../lib/groupBoxes'

/** World-px the box extends beyond member bounds (depth 0) + the per-nesting inset. */
export const GROUP_BOX_PAD = 20
export const GROUP_BOX_INSET_STEP = 12

/** Single vs double-click debounce window (ms): a mouse single-click defers this long so a
 *  double-click (focus) can cancel the select — kills the old select-then-focus flash (GROUP-02). */
const TAB_CLICK_DELAY = 220

export interface GroupBoxLayerProps {
  /** Single-click a tab = select all members; double-click = focus the group (S4/S5). */
  onTabClick?: (groupId: string) => void
  onTabDoubleClick?: (groupId: string) => void
  /** Right-click a tab = open the manage context menu at the click point (S5). */
  onTabContextMenu?: (groupId: string, at: { x: number; y: number }) => void
  /** The group box currently under a dragged board (S6 drop target) — glows accent. */
  dropTargetId?: string | null
}

export function GroupBoxLayer({
  onTabClick,
  onTabDoubleClick,
  onTabContextMenu,
  dropTargetId
}: GroupBoxLayerProps): ReactElement {
  const [tx, ty, zoom] = useStore((s) => s.transform)

  // GROUP-07: subscribe to a PRIMITIVE fingerprint of only the group structure + member rects
  // (groupMemberRectKey), not the whole `boards` array. Dragging an UNGROUPED board leaves the
  // key unchanged, so this layer doesn't re-render or recompute boxes at all — the per-frame
  // O(groups²) nesting scan only runs when a grouped board moves / membership changes. The boxes
  // memo reads the current snapshot via getState() (render was triggered by the key change).
  const memberKey = useCanvasStore((s) => groupMemberRectKey(s.groups, s.boards))
  const boxes = useMemo(
    () => {
      const s = useCanvasStore.getState()
      return computeGroupBoxes(s.groups, s.boards, {
        pad: GROUP_BOX_PAD,
        insetStep: GROUP_BOX_INSET_STEP
      })
    },
    // memberKey IS the cache key: it changes exactly when the snapshot's group structure / member
    // rects change — the only inputs computeGroupBoxes depends on. The linter can't see the
    // getState() read is gated by it, so it reads as "unnecessary"; it is load-bearing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberKey]
  )

  // One shared single-click timer (only one tab is interacted with at a time). Cleared on a
  // double-click and on unmount so a deferred select can't fire post-teardown.
  const clickTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current)
    },
    []
  )

  const handleTabClick = useCallback(
    (e: { detail: number }, id: string) => {
      // Ignore keyboard-synthesized clicks (detail 0) — Enter/Space are handled in onKeyDown so a
      // leaked synthetic click can't double-fire. Real mouse clicks defer so dblclick can cancel.
      if (e.detail === 0) return
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current)
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null
        onTabClick?.(id)
      }, TAB_CLICK_DELAY)
    },
    [onTabClick]
  )

  const handleTabDoubleClick = useCallback(
    (id: string) => {
      if (clickTimerRef.current != null) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      onTabDoubleClick?.(id)
    },
    [onTabDoubleClick]
  )

  // GROUP-02: full keyboard path for the group tab. Enter/Space = focus the group (its primary
  // action), ContextMenu / Shift+F10 = open the manage menu anchored under the tab. preventDefault
  // on Enter/Space suppresses the browser's synthesized click so the focus action isn't doubled.
  const handleTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        handleTabDoubleClick(id)
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        onTabContextMenu?.(id, { x: r.left, y: r.bottom })
      }
    },
    [handleTabDoubleClick, onTabContextMenu]
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
        // RF v12 renders <ReactFlow>'s children INSIDE `.react-flow__renderer`, so this layer
        // competes within the renderer's stacking context against the inner `.react-flow__pane`
        // (z-index 1) and `.react-flow__viewport` (boards, z-index 2). At z-index 0 the pane
        // painted over the tab and ate its clicks — the tab's pointer-events:auto never won the
        // hit-test (S5 right-click / S4 single+double-click were all swallowed by the pane).
        // z-index 5 (above pane/viewport, below RF's selection layer at 6) makes the tab a real
        // handle. The box BODY keeps pointer-events:none so only the tab is interactive; the
        // faint 1.5px accent-wash outline now paints just over board edges (negligible) instead
        // of behind them — an accepted trade for a functioning handle.
        zIndex: 5
      }}
    >
      {boxes.map((b) => (
        <div
          key={b.id}
          className={`group-box${b.id === dropTargetId ? ' group-box--drop-target' : ''}`}
          style={{ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h }}
        >
          <button
            type="button"
            className="group-box-tab"
            style={{ pointerEvents: 'auto' }}
            aria-label={`Group: ${b.name}`}
            onClick={(e) => handleTabClick(e, b.id)}
            onDoubleClick={() => handleTabDoubleClick(b.id)}
            onKeyDown={(e) => handleTabKeyDown(e, b.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              onTabContextMenu?.(b.id, { x: e.clientX, y: e.clientY })
            }}
            title={b.name}
          >
            {b.name}
          </button>
        </div>
      ))}
    </div>
  )
}

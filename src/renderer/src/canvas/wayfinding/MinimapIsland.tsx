/**
 * Wayfinding minimap island (design-audit D4-C — the LAST audit lane; user pick
 * 2026-06-11: minimap over board-list, toggled + remembered). The DESIGN.md §8
 * optional island: bottom-right, `--surface-raised` rounded rect, board rects in
 * `--border-strong`, viewport rect in `--accent` — themed via the `--xy-minimap-*`
 * vars in index.css (`.wayfinding-minimap`), no inline colors.
 *
 * React Flow's <MiniMap> does the rendering (it reads nodes + viewport from the RF
 * store, so this must mount INSIDE <ReactFlow>); this wrapper owns:
 *  - visibility (wayfindingStore; hidden ⇒ null — no DOM, no ADR 0002 chrome zone,
 *    zero cost; usePreviewManager.resolveChromeZones finds the island by class while
 *    visible, the toast-island pattern),
 *  - click a board rect → JUMP: the same camera-fit + dim-others path as
 *    Enter / double-click / palette-goto (D4-B `focusBoardById`, injected so the
 *    paths can never drift). stopPropagation keeps the svg-level click below from
 *    also firing on the same press,
 *  - click empty map → TELEPORT: center the camera there at the current zoom
 *    (§9 motion via cameraAnim; reduced-motion collapses it to instant),
 *  - drag the viewport mask → live pan / wheel → zoom (RF `pannable`/`zoomable`) —
 *    camera motion flows through useOnViewportChange like any pan, so preview
 *    detach/snapshot and the #122 settled-zoom snap apply unchanged.
 *
 * NOT an Esc layer: this is persistent chrome (like the dock), so it never joins the
 * confirm-gate → palette → full-view Esc stack.
 */
import { memo, useCallback, type MouseEvent, type ReactElement } from 'react'
import { MiniMap, useReactFlow, type Node } from '@xyflow/react'
import { useWayfindingStore } from '../../store/wayfindingStore'
import { cameraAnim } from '../../lib/motion'

export interface MinimapIslandProps {
  /** The D4-B focus path (camera-fit one board + dim the others). */
  onJumpToBoard: (id: string) => void
}

function MinimapIslandImpl({ onJumpToBoard }: MinimapIslandProps): ReactElement | null {
  const visible = useWayfindingStore((s) => s.minimapVisible)
  const rf = useReactFlow()

  const onNodeClick = useCallback(
    (e: MouseEvent, node: Node): void => {
      e.stopPropagation()
      // Deferred one macrotask: `pannable` runs d3-drag on this svg, and a click is a
      // zero-distance drag — its end-of-gesture viewport write can land AFTER the jump's
      // fitView starts and interrupt the camera tween at frame 0 (caught by the e2e
      // matrix under load). Starting the jump on a clean macrotask sequences it after
      // ALL of the click's gesture work, for real clicks as much as for the harness.
      const id = node.id
      window.setTimeout(() => onJumpToBoard(id), 0)
    },
    [onJumpToBoard]
  )

  const onMapClick = useCallback(
    (_e: MouseEvent, position: { x: number; y: number }): void => {
      void rf.setCenter(position.x, position.y, cameraAnim({ zoom: rf.getViewport().zoom }))
    },
    [rf]
  )

  if (!visible) return null
  return (
    <MiniMap
      className="wayfinding-minimap"
      pannable
      zoomable
      ariaLabel="Canvas minimap"
      // Stroke width is a PROP (not CSS): RF multiplies it by the map's view scale so
      // the viewport rect keeps a constant ~1.5px screen stroke at any canvas extent.
      maskStrokeWidth={1.5}
      onNodeClick={onNodeClick}
      onClick={onMapClick}
    />
  )
}

export const MinimapIsland = memo(MinimapIslandImpl)

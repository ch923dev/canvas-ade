/**
 * Tidy / tile layout actions, extracted from Canvas.tsx (Wave-5 B5 #2). Owns the camera
 * framing (`fitToBoards`), the window-manager tiling (`applyTile`), the preset entry point
 * (`tidyAndFit`), and the responsive-retile ResizeObserver loop. Only `tidyAndFit` is surfaced
 * (the keymap's `t`, the palette and AppChrome's Tidy picker).
 *
 * Spatial I2: every `tidy` preset runs the SHARED engine (`store/spatialTidy.runTidy` — the
 * same one an agent's `tidy_canvas` runs), which applies ONE undo step and frames the camera;
 * the user then gets the W3 / W7 feedback toast (`store/tidyFeedback`). No preset (the `t` key /
 * palette) = the IMPLICIT `roles` default (D8 a); a picked preset is explicit.
 */
import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'
import { getViewportForBounds, type ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { useCanvasViewTracker } from '../../store/canvasViewStore'
import { runTidy, tileArea } from '../../store/spatialTidy'
import { showTidyFeedback } from '../../store/tidyFeedback'
import { boardsBounds } from '../../lib/boardGeometry'
import { FIT_FRAME, Z_MAX, Z_MIN } from '../../lib/canvasView'
import { cameraAnim } from '../../lib/motion'
import { type LayoutPreset } from '../../lib/layoutPresets'
import type { TileTemplate } from '../../lib/tileLayout'

// The tile area moved into the engine module (the MCP `tile` mode shares it); re-exported so the
// existing imports keep working.
export { TILE_AREA_BASE_W, tileArea } from '../../store/spatialTidy'

export interface TidyTileDeps {
  paneRef: RefObject<HTMLDivElement | null>
  rf: ReactFlowInstance
  setActiveTile: Dispatch<SetStateAction<TileTemplate | null>>
  setFocusedId: Dispatch<SetStateAction<string | null>>
  activeTileRef: MutableRefObject<TileTemplate | null>
}

export function useTidyTile(deps: TidyTileDeps): { tidyAndFit: (preset?: LayoutPreset) => void } {
  const { paneRef, rf, setActiveTile, setFocusedId, activeTileRef } = deps
  const tileBoards = useCanvasStore((s) => s.tileBoards)
  // Spatial awareness (S0/C1): park the SAME pane's size (+ the settled camera) on the session-only
  // view bus so the React-free MCP tidy applier passes the pane aspect exactly like tidyAndFit below
  // does, and the MCP publisher can mirror the user's view to MAIN.
  useCanvasViewTracker(paneRef)

  // Pane (visible canvas) dimensions in screen px, from the absolute-inset pane element.
  const paneSize = useCallback((): { w: number; h: number } => {
    const el = paneRef.current
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 }
  }, [paneRef])

  // Frame the camera to the CURRENT store boards, computed from their post-arrange rects (not
  // rf.fitView) so it's race-free against React Flow's not-yet-synced controlled nodes.
  // `animate=false` (instant) is used for resize reflow so the layout doesn't tween every frame.
  const fitToBoards = useCallback(
    (animate = true) => {
      const { w, h } = paneSize()
      const boards = useCanvasStore.getState().boards
      const bb = boardsBounds(boards)
      if (!bb || w <= 0 || h <= 0) {
        void rf.fitView(animate ? cameraAnim(FIT_FRAME) : { ...FIT_FRAME, duration: 0 })
        return
      }
      const bounds = { x: bb.minX, y: bb.minY, width: bb.maxX - bb.minX, height: bb.maxY - bb.minY }
      const vp = getViewportForBounds(
        bounds,
        w,
        h,
        FIT_FRAME.minZoom ?? Z_MIN,
        FIT_FRAME.maxZoom ?? Z_MAX,
        FIT_FRAME.padding ?? 0.1
      )
      void rf.setViewport(vp, animate ? cameraAnim({}) : { duration: 0 })
    },
    [rf, paneSize]
  )

  // Tile every board into a pane-ASPECT block then frame it → fills the window like a WM.
  // `record` distinguishes a user-initiated apply (one undo step) from a live resize reflow
  // (untracked). The block's absolute size is irrelevant (the fit normalizes it).
  const applyTile = useCallback(
    (template: TileTemplate, record: boolean, animate: boolean) => {
      const { w, h } = paneSize()
      const aspect = w > 0 && h > 0 ? w / h : 16 / 10
      const area = tileArea(useCanvasStore.getState().boards, aspect)
      if (area) tileBoards(template, area, record)
      fitToBoards(animate)
    },
    [paneSize, tileBoards, fitToBoards]
  )

  // Apply a layout preset then frame it ("auto-fit"). Tile presets ALSO enter live "tiled mode"
  // (re-tile on window resize until released); tidy presets are one-shots that release tiling.
  const tidyAndFit = useCallback(
    (preset?: LayoutPreset) => {
      // Arranging must not leave others dimmed behind a stale focus (mirrors addCentered, #14).
      setFocusedId(null)
      if (preset?.kind === 'tile') {
        setActiveTile(preset.template)
        applyTile(preset.template, true, true)
        return
      }
      setActiveTile(null) // a tidy releases any live tiling
      // The engine reads the SAME pane (the view bus `useCanvasViewTracker` feeds from paneRef),
      // applies ONE undo step and frames the camera itself.
      const run = runTidy(preset ? { mode: preset.tidyMode } : {})
      if (run.ok) showTidyFeedback(run)
    },
    [applyTile, setActiveTile, setFocusedId]
  )

  // Responsive tiling: while a tile preset owns the layout, re-tile to the new window aspect on
  // every pane resize (minimize / restore / fullscreen). rAF-coalesced so a drag-resize storm
  // collapses to one reflow per frame; untracked so it never floods undo history.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    let raf = 0
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false // ResizeObserver fires once on observe; ignore that initial callback
        return
      }
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const t = activeTileRef.current
        if (t) applyTile(t, false, false)
      })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [applyTile, paneRef, activeTileRef])

  return { tidyAndFit }
}

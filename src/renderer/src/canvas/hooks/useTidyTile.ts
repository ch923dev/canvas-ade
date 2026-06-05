/**
 * Tidy / tile layout actions, extracted from Canvas.tsx (Wave-5 B5 #2). Owns the camera
 * framing (`fitToBoards`), the window-manager tiling (`applyTile`), the preset entry point
 * (`tidyAndFit`), and the responsive-retile ResizeObserver loop. Behavior-preserving — only
 * `tidyAndFit` is surfaced (the keymap's `t` and AppChrome's Tidy button); the rest is internal.
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
import { boardsBounds, type BoardRect } from '../../lib/boardGeometry'
import { FIT_FRAME, Z_MAX, Z_MIN } from '../../lib/canvasView'
import { cameraAnim } from '../../lib/motion'
import { LAYOUT_PRESETS, type LayoutPreset } from '../../lib/layoutPresets'
import type { TileTemplate } from '../../lib/tileLayout'

/** Default preset for the `t` key / direct Tidy click — the semantic "smart" auto-tidy. */
export const SMART_PRESET = LAYOUT_PRESETS[0]
/** Base width (world px) of the pane-aspect block a tile preset fills before the camera fits
 *  to it — absolute size is irrelevant (the fit normalizes it); only the aspect + zones matter. */
export const TILE_AREA_BASE_W = 2400

/**
 * The world-space block a tile layout fills: anchored at the boards' top-left corner, sized to
 * the pane `aspect` (w = baseW, h = baseW / aspect). Null when there are no boards. Pure.
 */
export function tileArea(
  boards: BoardRect[],
  aspect: number,
  baseW = TILE_AREA_BASE_W
): { x: number; y: number; w: number; h: number } | null {
  const bb = boardsBounds(boards)
  if (!bb) return null
  return { x: bb.minX, y: bb.minY, w: baseW, h: baseW / aspect }
}

export interface TidyTileDeps {
  paneRef: RefObject<HTMLDivElement>
  rf: ReactFlowInstance
  setActiveTile: Dispatch<SetStateAction<TileTemplate | null>>
  setFocusedId: Dispatch<SetStateAction<string | null>>
  activeTileRef: MutableRefObject<TileTemplate | null>
}

export function useTidyTile(deps: TidyTileDeps): { tidyAndFit: (preset?: LayoutPreset) => void } {
  const { paneRef, rf, setActiveTile, setFocusedId, activeTileRef } = deps
  const tileBoards = useCanvasStore((s) => s.tileBoards)
  const tidyBoards = useCanvasStore((s) => s.tidyBoards)

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
  // (re-tile on window resize until released); Smart is a one-shot that releases tiling.
  const tidyAndFit = useCallback(
    (preset: LayoutPreset = SMART_PRESET) => {
      // Arranging must not leave others dimmed behind a stale focus (mirrors addCentered, #14).
      setFocusedId(null)
      if (preset.kind === 'tile') {
        setActiveTile(preset.template)
        applyTile(preset.template, true, true)
      } else {
        setActiveTile(null) // Smart releases any live tiling
        tidyBoards(preset.tidyMode, paneSize().w / Math.max(1, paneSize().h))
        fitToBoards(true)
      }
    },
    [applyTile, tidyBoards, fitToBoards, paneSize, setActiveTile, setFocusedId]
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

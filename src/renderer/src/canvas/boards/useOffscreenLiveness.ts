import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useReactFlow, useOnViewportChange } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import type { BrowserBoard } from '../../lib/boardSchema'
import { stageScreenRect } from '../../lib/previewGeom'
import { isOsrVisible } from '../../lib/osrLiveness'
import { LOD_ZOOM } from '../../lib/canvasView'

/**
 * OS-3 Phase 2 (M2 / 2A) — the offscreen-preview LIVENESS manager.
 *
 * Mounted ONCE in `BrowserPreviewLayer` (above the OSR early-return, beside
 * `useBrowserAutoConnect` — the engine-agnostic slot), it decides per Browser board whether
 * its hidden offscreen window should keep PAINTING. An off-screen / below-LOD board is frozen
 * (`preview:osrSetPaint(false)` → MAIN `stopPainting`, CPU→0, the last frame stays on the
 * <canvas> as a free snapshot); a board back in view resumes (`true` → startPainting +
 * invalidate). This is the M2 CPU/battery fix — without it every board paints forever.
 *
 * It is far simpler than the native `usePreviewManager`: the OSR `<canvas>` clips/z-orders
 * like any DOM node, so there is NO occlusion demote, focus-isolation, or chrome-exclusion to
 * compute — only visibility (`osrLiveness.isOsrVisible`, pure + tested). And it preserves the
 * OSR path's defining win — ZERO per-frame camera IPC: it reconciles only on low-frequency
 * settles, and every `setOsrPaint` is DIFF-SKIPPED, so a settle that flips nothing sends
 * nothing.
 *
 * Reconcile triggers (mirrors the native manager's gating):
 *   - `useOnViewportChange({ onEnd })` — a camera pan/zoom SETTLE. A pure camera move leaves
 *     the `boards` array reference untouched, so the store subscription below misses it; this
 *     is the camera trigger.
 *   - the canvasStore `boards`-ref change — add/remove/geometry. A node drag mutates board
 *     geometry per frame (new `boards` array each frame), so this fires per drag-frame too —
 *     but `setOsrPaint` is diff-skipped and a board rarely flips visibility mid-drag, so the
 *     IPC stays ~zero (the compute is a few boards of cheap rect math).
 *
 * No-op unless `enabled` (VITE_PREVIEW_OSR) — in native mode the hook is mounted but inert.
 */
export function useOffscreenLiveness(
  enabled: boolean,
  paneRef: RefObject<HTMLDivElement | null>
): void {
  const { getViewport } = useReactFlow()
  // Last paint-state pushed per board, for diff-skip (only a CHANGED board fires IPC).
  const sentRef = useRef<Map<string, boolean>>(new Map())

  const reconcile = useCallback((): void => {
    if (!enabled) return
    const pane = paneRef.current?.getBoundingClientRect()
    if (!pane || pane.width === 0 || pane.height === 0) return
    const vp = getViewport()
    const paneOffset = { x: pane.left, y: pane.top }
    const paneBox = { x: pane.left, y: pane.top, width: pane.width, height: pane.height }
    const boards = useCanvasStore
      .getState()
      .boards.filter((b): b is BrowserBoard => b.type === 'browser')
    const sent = sentRef.current
    const seen = new Set<string>()
    for (const b of boards) {
      seen.add(b.id)
      const screen = stageScreenRect(
        { x: b.x, y: b.y, w: b.w, h: b.h, viewport: b.viewport },
        vp,
        paneOffset
      )
      const want = isOsrVisible({ screen, pane: paneBox, zoom: vp.zoom, lod: LOD_ZOOM })
      if (sent.get(b.id) !== want) {
        sent.set(b.id, want)
        void window.api.setOsrPaint(b.id, want)
      }
    }
    // Forget boards that no longer exist (a deleted board's window is disposed already), so a
    // future board reusing the id isn't diff-skipped against a stale entry.
    for (const id of [...sent.keys()]) if (!seen.has(id)) sent.delete(id)
  }, [enabled, getViewport, paneRef])

  // Camera settle (pan OR zoom end). reconcile no-ops when disabled, so registering this in
  // native mode is harmless.
  useOnViewportChange({ onEnd: reconcile })

  // Board geometry / membership changes + the initial reconcile.
  useEffect(() => {
    if (!enabled) return
    reconcile()
    let prevBoards = useCanvasStore.getState().boards
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.boards !== prevBoards) {
        prevBoards = s.boards
        reconcile()
      }
    })
    return unsub
  }, [enabled, reconcile])
}

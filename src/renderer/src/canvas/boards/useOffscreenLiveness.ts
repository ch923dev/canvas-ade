import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useReactFlow, useOnViewportChange } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { useOsrLivenessStore } from '../../store/osrLivenessStore'
import type { BrowserBoard } from '../../lib/boardSchema'
import { stageScreenRect } from '../../lib/previewGeom'
import { isOsrVisible, rankOsrAlive, type OsrAliveCandidate } from '../../lib/osrLiveness'
import { LOD_ZOOM } from '../../lib/canvasView'

/** Max concurrent EXISTING offscreen windows (2B — the RAM cap). Matches the native path's
 *  `MAX_LIVE`: a hidden offscreen renderer costs about as much RAM as a native preview view. */
const OSR_MAX_LIVE = 4

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
 *     is the camera trigger. SINGLE-SLOT (last writer wins): this hook is mounted ONLY in OSR
 *     mode (BrowserPreviewLayer › OffscreenLivenessLayer), where the native manager — the other
 *     `useOnViewportChange` owner — is not mounted, so the registrations never clash.
 *   - the canvasStore `boards`-ref change — add/remove/geometry. A node drag mutates board
 *     geometry per frame (new `boards` array each frame), so this fires per drag-frame too —
 *     but `setOsrPaint` is diff-skipped and a board rarely flips visibility mid-drag, so the
 *     IPC stays ~zero (the compute is a few boards of cheap rect math).
 */
export function useOffscreenLiveness(paneRef: RefObject<HTMLDivElement | null>): void {
  const { getViewport } = useReactFlow()
  // Last paint-state pushed per board, for diff-skip (only a CHANGED board fires IPC).
  const sentRef = useRef<Map<string, boolean>>(new Map())

  const reconcile = useCallback((): void => {
    const pane = paneRef.current?.getBoundingClientRect()
    if (!pane || pane.width === 0 || pane.height === 0) return
    const vp = getViewport()
    const paneOffset = { x: pane.left, y: pane.top }
    const paneBox = { x: pane.left, y: pane.top, width: pane.width, height: pane.height }
    const center = { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }
    const boards = useCanvasStore
      .getState()
      .boards.filter((b): b is BrowserBoard => b.type === 'browser')

    // First pass: each board's screen rect + visibility (2A).
    const candidates: OsrAliveCandidate[] = boards.map((b) => {
      const screen = stageScreenRect(
        { x: b.x, y: b.y, w: b.w, h: b.h, viewport: b.viewport },
        vp,
        paneOffset
      )
      return {
        id: b.id,
        screen,
        visible: isOsrVisible({ screen, pane: paneBox, zoom: vp.zoom, lod: LOD_ZOOM })
      }
    })

    // 2B — rank for the MAX_LIVE existence cap (visible-first, then nearest the pane centre) and
    // publish each board's alive flag. useOffscreenPreview gates its window open/close on it.
    const aliveSet = rankOsrAlive({ candidates, cap: OSR_MAX_LIVE, center })
    const aliveRecord: Record<string, boolean> = {}
    for (const c of candidates) aliveRecord[c.id] = aliveSet.has(c.id)
    useOsrLivenessStore.getState().setAlive(aliveRecord)

    // 2A — paint-gate only the ALIVE boards (an evicted board's window is closed, so a setPaint
    // is moot). paint = visible; an alive-but-off-screen board is kept WARM (loaded, frozen) so
    // panning to it resumes instantly. Diff-skipped → no IPC on a no-flip settle.
    const sent = sentRef.current
    const seen = new Set<string>()
    for (const c of candidates) {
      if (!aliveSet.has(c.id)) {
        // Evicted: drop the diff entry so a future revive re-sends its paint state fresh.
        sent.delete(c.id)
        continue
      }
      seen.add(c.id)
      const want = c.visible
      if (sent.get(c.id) !== want) {
        sent.set(c.id, want)
        void window.api.setOsrPaint(c.id, want)
      }
    }
    // Forget boards that no longer exist (a deleted board's window is disposed already), so a
    // future board reusing the id isn't diff-skipped against a stale entry.
    for (const id of [...sent.keys()]) if (!seen.has(id)) sent.delete(id)
  }, [getViewport, paneRef])

  // Camera settle (pan OR zoom end).
  useOnViewportChange({ onEnd: reconcile })

  // Board geometry / membership changes + the initial reconcile.
  useEffect(() => {
    reconcile()
    let prevBoards = useCanvasStore.getState().boards
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.boards !== prevBoards) {
        prevBoards = s.boards
        reconcile()
      }
    })
    return unsub
  }, [reconcile])
}

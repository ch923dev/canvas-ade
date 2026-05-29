/**
 * Browser PreviewManager (Phase 2.2) — the store-driven extraction of the Phase 1
 * spike's `<PreviewManager>` (`smoke/FlowSmoke.tsx`). Mounted ONCE inside
 * `<ReactFlow>` (Canvas.tsx) so it can read the live camera via `useReactFlow` +
 * `useOnViewportChange` (never from React re-renders — see ADR 0002 / CLAUDE.md).
 *
 * It drives ALL Browser boards' native `WebContentsView`s from the canvas store:
 * each board's native rect is the device-frame inner rect (browserLayout) mapped to
 * screen via `cameraBounds.worldRectToScreen`, and its zoom factor holds the page at
 * the preset CSS width via `cameraBounds.fitZoomFactor`. Every frame it emits ONE
 * coalesced `setPreviewBoundsBatch` IPC for all attached boards (diff-skipped with
 * `rectsEqual`). Motion + LOD are carried by HTML snapshots: capture→snapshot→detach
 * on move start (a native view can't be clipped/can't trail), reattach on move end
 * for the boards that should be live, under the `MAX_LIVE` cap.
 *
 * Per-board RUNTIME state (snapshot, status, live URL, back/forward, live flag) is
 * written to the ephemeral `previewStore`; the BrowserBoard component reads it. The
 * board's durable `url` / `viewport` live on the board in `canvasStore`.
 *
 * Security: this never writes to the PTY; it only steers each view's own
 * webContents (load / nav), and external link opens are denied → shell.openExternal
 * (main). App chrome stays OUTSIDE the native rect (the device frame is HTML around
 * an unrounded native rect), so the always-above native layer can't cover it.
 */
import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { useReactFlow, useOnViewportChange } from '@xyflow/react'
import { roundRect, worldRectToScreen, rectsEqual, fitZoomFactor } from '../../lib/cameraBounds'
import type { Rect } from '../../lib/cameraBounds'
import { LOD_ZOOM } from '../../lib/canvasView'
import { isLiveEligible, pickLive } from '../../lib/previewPlan'
import {
  VIEWPORT_PRESETS,
  deviceStageRect,
  toWorldRect,
  type ViewportPreset
} from '../../lib/browserLayout'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore } from '../../store/previewStore'
import type { BrowserBoard, BrowserViewport } from '../../lib/boardSchema'

/** Cap concurrent live renderers (ADR 0002); over-cap boards fall back to snapshot. */
const MAX_LIVE = 4

interface PaneOffset {
  x: number
  y: number
}

/** Minimal geometry the manager needs per board (snapshot of the store row). */
interface BoardGeom {
  id: string
  x: number
  y: number
  w: number
  h: number
  url: string
  viewport: BrowserViewport
}

/** Per-board native-view bookkeeping (mirrors the spike `BoardRec`). */
interface BoardRec {
  /** A native view is created (open) and not yet closed. */
  exists: boolean
  /** The native view is currently attached over the board. */
  attached: boolean
  /** Last bounds + zoom pushed, for diff-skip. */
  lastSent: Rect | null
  lastZoom: number
  /** Last loaded URL, so a board.url edit triggers a navigate. */
  lastUrl: string | null
}

interface LayerProps {
  /** The React Flow pane element, for the paneOffset measurement (full-bleed). */
  paneRef: React.RefObject<HTMLDivElement | null>
}

export function BrowserPreviewLayer({ paneRef }: LayerProps): ReactElement | null {
  const { getViewport } = useReactFlow()
  const patchRuntime = usePreviewStore((s) => s.patch)
  const clearRuntime = usePreviewStore((s) => s.clear)

  // paneOffset = the RF pane top-left in window CSS px. The canvas is now full-bleed
  // (App.tsx → position:fixed inset:0), so this is ~ (0,0) — but MEASURE it (a future
  // bar/inset would shift it). setBounds wants window-content DIP coords.
  const paneOffset = useRef<PaneOffset>({ x: 0, y: 0 })
  const recs = useRef<Map<string, BoardRec>>(new Map())
  // Latest board geometry, refreshed from the store subscription (read in rAF).
  const geomRef = useRef<Map<string, BoardGeom>>(new Map())
  const gestureRef = useRef(false)
  const rafRef = useRef(0)
  const idleRef = useRef(0)

  const preset = useCallback((vp: BrowserViewport): ViewportPreset => VIEWPORT_PRESETS[vp], [])

  /** The board's native-view stage rect in screen (pane-local + offset) space. */
  const boundsFor = useCallback(
    (g: BoardGeom): Rect => {
      const stage = toWorldRect(deviceStageRect(g.w, g.h, g.viewport), g.x, g.y)
      return roundRect(worldRectToScreen(stage, getViewport(), paneOffset.current))
    },
    [getViewport]
  )

  /** Zoom factor that holds the page at the preset CSS width (responsive trick). */
  const zoomFor = useCallback(
    (g: BoardGeom): number => {
      const stage = deviceStageRect(g.w, g.h, g.viewport)
      return fitZoomFactor(stage.width, preset(g.viewport).w, getViewport().zoom)
    },
    [getViewport, preset]
  )

  // A board may be LIVE only if zoomed in enough AND its stage has positive size and
  // sits at/below the pane top (a native view can't be clipped above the pane).
  const liveEligible = useCallback(
    (g: BoardGeom): boolean => {
      const vp = getViewport()
      const stage = deviceStageRect(g.w, g.h, g.viewport)
      const s = worldRectToScreen(toWorldRect(stage, g.x, g.y), vp, paneOffset.current)
      return isLiveEligible({
        zoom: vp.zoom,
        lod: LOD_ZOOM,
        screenY: s.y,
        paneTop: paneOffset.current.y,
        w: stage.width,
        h: stage.height
      })
    },
    [getViewport]
  )

  const rec = useCallback((id: string): BoardRec => {
    let r = recs.current.get(id)
    if (!r) {
      r = { exists: false, attached: false, lastSent: null, lastZoom: 0, lastUrl: null }
      recs.current.set(id, r)
    }
    return r
  }, [])

  // Capture → snapshot → detach one live board (so HTML carries motion/LOD/over-cap).
  const demoteToSnapshot = useCallback(
    async (g: BoardGeom): Promise<void> => {
      const r = rec(g.id)
      if (!r.attached) return
      const url = await window.api.capturePreview(g.id)
      if (url) patchRuntime(g.id, { snapshot: url })
      await window.api.detachPreview(g.id)
      r.attached = false
      patchRuntime(g.id, { live: false })
    },
    [rec, patchRuntime]
  )

  // Bring a board's live view onto its device stage (creating the renderer if
  // needed). The snapshot stays as a fallback UNDER the native layer so a reattach
  // never flashes the bare frame.
  const attachBoard = useCallback(
    async (g: BoardGeom): Promise<void> => {
      const r = rec(g.id)
      const bounds = boundsFor(g)
      const zoomFactor = zoomFor(g)
      r.lastSent = bounds
      r.lastZoom = zoomFactor
      r.attached = true
      if (r.exists) {
        void window.api.attachPreview({ id: g.id, bounds, zoomFactor })
      } else {
        r.exists = true
        r.lastUrl = g.url
        patchRuntime(g.id, { status: 'connecting', live: true })
        await window.api.openPreview({ id: g.id, url: g.url, bounds, zoomFactor })
      }
      patchRuntime(g.id, { live: true })
    },
    [rec, boundsFor, zoomFor, patchRuntime]
  )

  // Free a renderer (over the live cap / board removed). Last snapshot keeps showing.
  const closeBoard = useCallback(
    (id: string): void => {
      const r = rec(id)
      r.attached = false
      r.exists = false
      r.lastSent = null
      r.lastUrl = null
      void window.api.closePreview(id)
      patchRuntime(id, { live: false })
    },
    [rec, patchRuntime]
  )

  // One coalesced batch per frame for every attached board, diff-skipped.
  const flushBatch = useCallback((): boolean => {
    const items: Array<{ id: string; bounds: Rect; zoomFactor: number }> = []
    for (const g of geomRef.current.values()) {
      const r = recs.current.get(g.id)
      if (!r || !r.attached) continue
      const bounds = boundsFor(g)
      const zoomFactor = zoomFor(g)
      if (r.lastSent && rectsEqual(r.lastSent, bounds) && r.lastZoom === zoomFactor) continue
      r.lastSent = bounds
      r.lastZoom = zoomFactor
      items.push({ id: g.id, bounds, zoomFactor })
    }
    if (!items.length) return false
    void window.api.setPreviewBoundsBatch(items)
    return true
  }, [boundsFor, zoomFor])

  const startPump = useCallback((): void => {
    if (rafRef.current) return
    idleRef.current = 0
    const step = (): void => {
      idleRef.current = flushBatch() ? 0 : idleRef.current + 1
      // Self-stopping: a few idle frames after movement settles, the loop ends.
      rafRef.current = idleRef.current < 4 ? requestAnimationFrame(step) : 0
    }
    rafRef.current = requestAnimationFrame(step)
  }, [flushBatch])

  // onMoveStart: keep tracking (pump) AND capture every live board → snapshot →
  // detach, so HTML images carry the motion (no trailing native layers).
  const beginMotion = useCallback((): void => {
    startPump()
    if (gestureRef.current) return
    const live = [...geomRef.current.values()].filter((g) => recs.current.get(g.id)?.attached)
    if (!live.length) return
    gestureRef.current = true
    void (async () => {
      const shots = await Promise.all(live.map((g) => window.api.capturePreview(g.id)))
      if (!gestureRef.current) return // gesture ended before capture → keep live
      const captured: BoardGeom[] = []
      live.forEach((g, i) => {
        if (shots[i]) {
          patchRuntime(g.id, { snapshot: shots[i] })
          captured.push(g)
        }
      })
      await Promise.all(captured.map((g) => window.api.detachPreview(g.id)))
      captured.forEach((g) => {
        const r = recs.current.get(g.id)
        if (r) r.attached = false
        patchRuntime(g.id, { live: false })
      })
    })()
  }, [startPump, patchRuntime])

  // onMoveEnd: reattach the boards that should be live (zoom ≥ LOD, under the cap);
  // over-cap eligible boards are CLOSED (free the renderer); below-LOD boards stay
  // snapshot. Already-detached snapshot boards keep their image for a fast reattach.
  const endMotion = useCallback((): void => {
    gestureRef.current = false
    const all = [...geomRef.current.values()]
    const wantLive = all.filter((g) => liveEligible(g))
    const liveIds = new Set(pickLive(wantLive, MAX_LIVE))
    for (const g of all) {
      const r = rec(g.id)
      if (liveIds.has(g.id)) void attachBoard(g)
      else if (wantLive.includes(g))
        closeBoard(g.id) // over the live cap → free renderer
      else if (r.attached) void demoteToSnapshot(g) // LOD / chrome zone → snapshot
    }
  }, [liveEligible, rec, attachBoard, closeBoard, demoteToSnapshot])

  useOnViewportChange({ onStart: beginMotion, onChange: startPump, onEnd: endMotion })

  // ── Reconcile the native views with the store's Browser boards ────────────────
  // Subscribe imperatively (NOT via a hook selector that re-renders) so geometry +
  // url + viewport changes update the views without re-rendering this layer.
  const reconcile = useCallback(
    (boards: BoardGeom[]): void => {
      const seen = new Set(boards.map((g) => g.id))
      geomRef.current = new Map(boards.map((g) => [g.id, g]))

      // Removed boards: close + clear runtime.
      for (const id of [...recs.current.keys()]) {
        if (!seen.has(id)) {
          closeBoard(id)
          recs.current.delete(id)
          clearRuntime(id)
        }
      }

      for (const g of boards) {
        const r = rec(g.id)
        if (!r.exists && !r.attached) {
          // New board (or one whose renderer was freed): bring it live if eligible.
          if (liveEligible(g)) void attachBoard(g)
        } else if (r.exists) {
          // URL edit → navigate (resets zoom; did-finish-load re-applies the factor).
          if (g.url !== r.lastUrl) {
            r.lastUrl = g.url
            patchRuntime(g.id, { status: 'connecting' })
            void window.api.navigatePreview(g.id, g.url)
          }
          // Viewport / geometry change → re-push bounds + zoom for attached boards.
          if (r.attached) {
            const bounds = boundsFor(g)
            const zoomFactor = zoomFor(g)
            r.lastSent = bounds
            r.lastZoom = zoomFactor
            void window.api.attachPreview({ id: g.id, bounds, zoomFactor })
          }
        }
      }
    },
    [rec, closeBoard, clearRuntime, liveEligible, attachBoard, boundsFor, zoomFor, patchRuntime]
  )

  useEffect(() => {
    const toGeom = (boards: ReturnType<typeof useCanvasStore.getState>['boards']): BoardGeom[] =>
      boards
        .filter((b): b is BrowserBoard => b.type === 'browser')
        .map((b) => ({
          id: b.id,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          url: b.url,
          viewport: b.viewport
        }))

    // Initial sync, then on every store change.
    reconcile(toGeom(useCanvasStore.getState().boards))
    const unsub = useCanvasStore.subscribe((s) => reconcile(toGeom(s.boards)))
    return unsub
  }, [reconcile])

  // paneOffset: the RF pane top-left in window CSS px. Once per layout (ResizeObserver
  // + window resize), never per frame — then re-flush the batch.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      paneOffset.current = { x: r.left, y: r.top }
      flushBatch()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [paneRef, flushBatch])

  // ── Lifecycle events from main (load / navigate / fail) → runtime store ────────
  useEffect(() => {
    const off = window.api.onPreviewEvent((ev) => {
      if (ev.type === 'did-finish-load') {
        patchRuntime(ev.id, { status: 'connected', liveUrl: ev.url, error: null })
      } else if (ev.type === 'did-navigate') {
        patchRuntime(ev.id, {
          liveUrl: ev.url,
          canGoBack: ev.canGoBack,
          canGoForward: ev.canGoForward
        })
      } else if (ev.type === 'did-fail-load') {
        patchRuntime(ev.id, { status: 'load-failed', error: ev.errorDescription })
      }
    })
    return off
  }, [patchRuntime])

  // Tear down on unmount (HMR / route change): stop the pump + close every view.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void window.api.closeAllPreviews()
    },
    []
  )

  return null
}

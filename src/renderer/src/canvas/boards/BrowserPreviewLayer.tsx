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
import {
  isLiveEligible,
  pickLive,
  chromeExclusionZones,
  shouldDemoteForOcclusion,
  type Box
} from '../../lib/previewPlan'
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

interface PaneSize {
  w: number
  h: number
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
  /**
   * Bumped on every (re)attach. demoteToSnapshot snapshots this before its capture
   * await; if it changed when the await resolves, a concurrent attach re-claimed the
   * board (Bug #45) and the demote must not detach it.
   */
  attachSeq: number
}

interface LayerProps {
  /** The React Flow pane element, for the paneOffset measurement (full-bleed). */
  paneRef: React.RefObject<HTMLDivElement | null>
  /**
   * The currently focused board id (double-click focus), or null. A native view
   * ignores the HTML dim-others, so while a focus is active every non-focused
   * Browser board demotes to its dimmable snapshot (see `liveEligible`).
   */
  focusedId: string | null
}

export function BrowserPreviewLayer({ paneRef, focusedId }: LayerProps): ReactElement | null {
  const { getViewport } = useReactFlow()
  const patchRuntime = usePreviewStore((s) => s.patch)
  const clearRuntime = usePreviewStore((s) => s.clear)
  // A board drag/resize is in progress (React Flow node-drag / NodeResizer). Unlike
  // a camera move it never fires useOnViewportChange, so we detach live views here.
  const nodeGesture = usePreviewStore((s) => s.nodeGesture)

  // paneOffset = the RF pane top-left in window CSS px. The canvas is now full-bleed
  // (App.tsx → position:fixed inset:0), so this is ~ (0,0) — but MEASURE it (a future
  // bar/inset would shift it). setBounds wants window-content DIP coords.
  const paneOffset = useRef<PaneOffset>({ x: 0, y: 0 })
  // Pane size in CSS px (same layout cadence as paneOffset). Used to rank live
  // candidates by distance to the viewport centre (Bug #8).
  const paneSize = useRef<PaneSize>({ w: 0, h: 0 })
  const recs = useRef<Map<string, BoardRec>>(new Map())
  // Latest board geometry, refreshed from the store subscription (read in rAF).
  const geomRef = useRef<Map<string, BoardGeom>>(new Map())
  const gestureRef = useRef(false)
  const rafRef = useRef(0)
  const idleRef = useRef(0)
  // Latest focused board id, read inside the (geometry-only-deps) liveEligible cb.
  const focusedIdRef = useRef<string | null>(focusedId)
  // Latest store selection + the selected board's WORLD rect (any board type), kept
  // fresh by the store subscription. Used by the static-occlusion demote (LOT F #2/
  // #19/#20): a live Browser view overlapping a DIFFERENT selected board must demote
  // to its (clippable, z-ordered) HTML snapshot so that board shows its ring/handles
  // and receives input. Null when nothing — or a Browser board itself — is selected.
  const selectedIdRef = useRef<string | null>(null)
  const selectedRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

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

  // The board's device-stage rect in screen (pane-local + offset) space — the raw,
  // un-rounded rect used for eligibility + viewport-distance ranking.
  const stageScreenRect = useCallback(
    (g: BoardGeom): Rect => {
      const stage = deviceStageRect(g.w, g.h, g.viewport)
      return worldRectToScreen(toWorldRect(stage, g.x, g.y), getViewport(), paneOffset.current)
    },
    [getViewport]
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
        h: stage.height,
        focusActive: focusedIdRef.current !== null,
        isFocused: focusedIdRef.current === g.id
      })
    },
    [getViewport]
  )

  // Static-occlusion demote (LOT F): a live Browser view must fall back to its HTML
  // snapshot when, AT REST, its native stage would paint over (a) a DIFFERENT selected
  // board (#2/#19/#20 — restore that board's ring/handles + input) or (b) the fixed
  // app-chrome zones (#21 — dock / camera cluster / DiagOverlay). Geometry is resolved
  // to screen space here; the pure predicate decides. Kept narrow so a non-overlapping,
  // unselected live preview is never needlessly demoted (the e2e `browser` live guard).
  const occludesProtected = useCallback(
    (g: BoardGeom): boolean => {
      const vp = getViewport()
      const stage = stageScreenRect(g)
      const stageBox: Box = { x: stage.x, y: stage.y, width: stage.width, height: stage.height }
      const sel = selectedRectRef.current
      let selectedRect: Box | null = null
      if (sel) {
        const s = worldRectToScreen(
          { x: sel.x, y: sel.y, width: sel.w, height: sel.h },
          vp,
          paneOffset.current
        )
        selectedRect = { x: s.x, y: s.y, width: s.width, height: s.height }
      }
      const chromeZones = chromeExclusionZones({
        x: paneOffset.current.x,
        y: paneOffset.current.y,
        w: paneSize.current.w,
        h: paneSize.current.h
      })
      return shouldDemoteForOcclusion({
        id: g.id,
        stage: stageBox,
        selectedId: selectedIdRef.current,
        selectedRect,
        chromeZones
      })
    },
    [getViewport, stageScreenRect]
  )

  const rec = useCallback((id: string): BoardRec => {
    let r = recs.current.get(id)
    if (!r) {
      r = {
        exists: false,
        attached: false,
        lastSent: null,
        lastZoom: 0,
        lastUrl: null,
        attachSeq: 0
      }
      recs.current.set(id, r)
    }
    return r
  }, [])

  // Capture → snapshot → detach one live board (so HTML carries motion/LOD/over-cap).
  const demoteToSnapshot = useCallback(
    async (g: BoardGeom): Promise<void> => {
      const r = rec(g.id)
      if (!r.attached) return
      const seq = r.attachSeq
      // Bug #8/#9: a rejected capturePage() (headless / GPU-contended host) must NOT
      // abort the detach — the native view paints above all HTML, so it MUST still be
      // pulled out. Treat a capture failure like an empty snapshot (url = null) and
      // proceed to the detach + state-clear regardless.
      let url: string | null = null
      try {
        url = await window.api.capturePreview(g.id)
      } catch {
        url = null
      }
      // Re-check after the capture IPC round-trip:
      //  • Bug #48 — the board may have been deleted mid-capture (reconcile removed
      //    its rec + cleared its runtime); patching here would resurrect an orphan.
      //  • Bug #45 — a concurrent attach (zoomed back in across LOD) re-claimed this
      //    board (attachSeq bumped), so it should stay live, not be detached.
      if (!recs.current.has(g.id)) return
      if (!r.attached || r.attachSeq !== seq) return
      if (url) patchRuntime(g.id, { snapshot: url })
      await window.api.detachPreview(g.id)
      if (!r.attached || r.attachSeq !== seq) return
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
      // Diff-skip a redundant re-attach: if the view is already attached at exactly
      // these bounds/zoom, re-issuing attachPreview re-adds the child view (a wasted
      // IPC + attachSeq bump for nothing). The new selection-driven applyLiveness
      // (LOT F) can call attachBoard on an already-correct live board, so this keeps
      // that a true no-op — mirrors the reconcile Bug #44 diff-skip. A genuine
      // move / re-attach (detached, or bounds/zoom changed) still falls through.
      if (
        r.exists &&
        r.attached &&
        r.lastSent &&
        rectsEqual(r.lastSent, bounds) &&
        r.lastZoom === zoomFactor
      ) {
        patchRuntime(g.id, { live: true })
        return
      }
      r.lastSent = bounds
      r.lastZoom = zoomFactor
      r.attached = true
      r.attachSeq++
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
      // Bug #8/#9: capture per-board with a per-item guard so ONE rejected
      // capturePage() (headless / GPU-contended host) can't reject the whole batch and
      // abort every board's detach. A failed/empty capture resolves to null → that
      // board keeps its live native view (not detached blind) while the rest snapshot
      // + detach normally.
      const shots = await Promise.all(
        live.map((g) => window.api.capturePreview(g.id).catch(() => null))
      )
      if (!gestureRef.current) return // gesture ended before capture → keep live
      const captured: BoardGeom[] = []
      live.forEach((g, i) => {
        // Bug #48: a board deleted mid-capture had its rec removed + runtime cleared
        // by reconcile; patching here would resurrect an orphaned previewStore entry.
        if (shots[i] && recs.current.has(g.id)) {
          patchRuntime(g.id, { snapshot: shots[i] })
          captured.push(g)
        }
      })
      await Promise.all(captured.map((g) => window.api.detachPreview(g.id)))
      captured.forEach((g) => {
        const r = recs.current.get(g.id)
        if (!r) return // removed during the detach await (Bug #48)
        r.attached = false
        patchRuntime(g.id, { live: false })
      })
    })()
  }, [startPump, patchRuntime])

  // Recompute which boards should be live (zoom ≥ LOD, on-pane, focus, under the
  // cap) and reconcile each: attach the winners, CLOSE over-cap eligible boards
  // (free the renderer), demote the rest to snapshot. Shared by motion-end, node
  // gestures, and focus changes. Already-detached boards keep their image for a fast
  // reattach.
  const applyLiveness = useCallback((): void => {
    const all = [...geomRef.current.values()]
    // A board may go live only if base-eligible (zoom/on-pane/focus) AND not statically
    // occluding a selected board or the app chrome (LOT F #2/#19/#20/#21). The
    // occlusion-demoted set keeps its renderer + snapshot for a fast reattach once the
    // overlap clears (handled in the else-branch, like LOD), so it is NOT closed.
    const wantLive = all.filter((g) => liveEligible(g) && !occludesProtected(g))
    // Bug #8: rank the live winners by distance to the viewport centre so the board
    // the user navigated to wins a live slot over off-screen earlier-created boards.
    const candidates = wantLive.map((g) => {
      const s = stageScreenRect(g)
      return { id: g.id, screenX: s.x, screenY: s.y, w: s.width, h: s.height }
    })
    const center = {
      x: paneOffset.current.x + paneSize.current.w / 2,
      y: paneOffset.current.y + paneSize.current.h / 2
    }
    const liveIds = new Set(pickLive(candidates, MAX_LIVE, center))
    for (const g of all) {
      const r = rec(g.id)
      if (liveIds.has(g.id)) void attachBoard(g)
      else if (wantLive.includes(g)) {
        // Over the live cap. Free the renderer ONLY when there is a snapshot (or a
        // still-attached native view) to fall back on; a never-captured board would
        // otherwise show a blank device frame (Bug #24) — leave it for reconcile to
        // attach once a live slot frees.
        const rt = usePreviewStore.getState().byId[g.id]
        if (r.exists || rt?.snapshot) closeBoard(g.id)
      } else if (r.attached) void demoteToSnapshot(g) // LOD / chrome / occlusion / unfocused → snapshot
    }
  }, [
    liveEligible,
    occludesProtected,
    stageScreenRect,
    rec,
    attachBoard,
    closeBoard,
    demoteToSnapshot
  ])

  // onMoveEnd: clear the gesture flag, then reconcile liveness at the rest position.
  const endMotion = useCallback((): void => {
    gestureRef.current = false
    applyLiveness()
  }, [applyLiveness])

  useOnViewportChange({ onStart: beginMotion, onChange: startPump, onEnd: endMotion })

  // ── Node drag/resize gestures + focus changes (no camera move → no viewport event) ──
  // A node drag/resize START detaches every live view → HTML snapshot (so a board
  // dragged over a live Browser board isn't occluded by its always-above native
  // layer); the gesture END reattaches the eligible ones. Skip the initial mount tick
  // (gesture is already false). begin/endMotion are stable (deps don't include
  // nodeGesture), so this effect runs on real gesture toggles; re-running on a rare
  // callback-identity change is safe (begin guards on gestureRef, end is idempotent).
  const gestureMounted = useRef(false)
  useEffect(() => {
    if (!gestureMounted.current) {
      gestureMounted.current = true
      return
    }
    if (nodeGesture) beginMotion()
    else endMotion()
  }, [nodeGesture, beginMotion, endMotion])

  // Focus change → re-evaluate liveness (focused board stays live, others demote to
  // their dimmable snapshot). Focus also fits the camera (→ onMoveEnd already
  // reconciles), but UNFOCUS via Esc moves no camera, so re-apply here too.
  const focusMounted = useRef(false)
  useEffect(() => {
    focusedIdRef.current = focusedId
    if (!focusMounted.current) {
      focusMounted.current = true
      return
    }
    applyLiveness()
  }, [focusedId, applyLiveness])

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
          // New board (or one whose renderer was freed): bring it live if eligible AND
          // not statically occluding a selected board / the app chrome (LOT F).
          if (liveEligible(g) && !occludesProtected(g)) void attachBoard(g)
          // Bug #3: a board created below LOD / off-pane isn't yet eligible, so it
          // would otherwise sit on the dead idle default (empty stage, no label)
          // until a later zoom gesture attaches it. Show the 'Connecting…'
          // placeholder so it doesn't read as broken; endMotion/reconcile will
          // attach + load it once it becomes eligible.
          else if ((usePreviewStore.getState().byId[g.id]?.status ?? 'idle') === 'idle')
            patchRuntime(g.id, { status: 'connecting' })
        } else if (r.exists) {
          // URL edit → navigate (resets zoom; did-finish-load re-applies the factor).
          if (g.url !== r.lastUrl) {
            r.lastUrl = g.url
            patchRuntime(g.id, { status: 'connecting' })
            void window.api.navigatePreview(g.id, g.url)
          }
          // Viewport / geometry change → re-push bounds + zoom for attached boards.
          // Bug #44: diff-skip an unchanged board (mirrors flushBatch) so a store
          // mutation on ANOTHER board (drag, select, setTool) doesn't fire a
          // redundant preview:attach IPC for every already-positioned view.
          if (r.attached) {
            const bounds = boundsFor(g)
            const zoomFactor = zoomFor(g)
            if (r.lastSent && rectsEqual(r.lastSent, bounds) && r.lastZoom === zoomFactor) continue
            r.lastSent = bounds
            r.lastZoom = zoomFactor
            void window.api.attachPreview({ id: g.id, bounds, zoomFactor })
          }
        }
      }
    },
    [
      rec,
      closeBoard,
      clearRuntime,
      liveEligible,
      occludesProtected,
      attachBoard,
      boundsFor,
      zoomFor,
      patchRuntime
    ]
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

    // Refresh the selection refs (LOT F): the selected board's id + WORLD rect (any
    // type). A live Browser view overlapping a DIFFERENT selected board demotes to its
    // snapshot so that board is interactable. Returns true when the selection signal
    // (id or the selected board's rect) changed — the layer then re-runs applyLiveness.
    const syncSelection = (s: ReturnType<typeof useCanvasStore.getState>): boolean => {
      const id = s.selectedId
      const b = id ? s.boards.find((x) => x.id === id) : undefined
      const rect = b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null
      const prev = selectedRectRef.current
      const changed =
        id !== selectedIdRef.current ||
        rect?.x !== prev?.x ||
        rect?.y !== prev?.y ||
        rect?.w !== prev?.w ||
        rect?.h !== prev?.h
      selectedIdRef.current = id
      selectedRectRef.current = rect
      return changed
    }

    // Initial sync, then on every store change.
    syncSelection(useCanvasStore.getState())
    reconcile(toGeom(useCanvasStore.getState().boards))
    const unsub = useCanvasStore.subscribe((s) => {
      const selChanged = syncSelection(s)
      reconcile(toGeom(s.boards))
      // Selection (or the selected board's geometry) changed but no camera/node gesture
      // is in flight → re-evaluate static occlusion so an already-attached Browser view
      // demotes (or reattaches) against the new selection. Geometry-driven changes are
      // already handled by reconcile's bounds re-push + the gesture/move paths.
      if (selChanged && !gestureRef.current) applyLiveness()
    })
    return unsub
  }, [reconcile, applyLiveness])

  // paneOffset: the RF pane top-left in window CSS px. Once per layout (ResizeObserver
  // + window resize), never per frame — then re-flush the batch.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      paneOffset.current = { x: r.left, y: r.top }
      paneSize.current = { w: r.width, h: r.height }
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
      // A fresh main-frame navigation STARTED (reload / back / forward / in-page link).
      // Clear a stale `load-failed` latch so the following did-finish-load can promote
      // to `connected` after a successful recovery load (Bug #5). The preload
      // `PreviewEvent` union doesn't declare this additive variant, so compare via a
      // widened string. Only clears the load-failed latch — the error page's OWN
      // did-finish-load is still suppressed (main reuses the failed navigation and
      // emits no fresh did-start-navigation for it).
      if ((ev.type as string) === 'did-start-navigation') {
        // Recovery only matters for a board that still has a live native view; ignore
        // an in-flight nav-start for an evicted/deleted board (Bug #18/#32 — no rec, or
        // its renderer was freed → don't resurrect or mutate a stale entry).
        if (!recs.current.get(ev.id)?.exists) return
        const cur = usePreviewStore.getState().byId[ev.id]?.status
        if (cur === 'load-failed') patchRuntime(ev.id, { status: 'connecting', error: null })
        return
      }
      if (ev.type === 'did-finish-load') {
        // Bug #18: reconcile against the lifecycle before promoting. An over-cap-evicted
        // board (closeBoard cleared exists/attached + live, but left status 'connecting')
        // whose load completes just as its view is closed would otherwise flip to a green
        // 'connected' over a detached snapshot with no live view. Skip when there is no
        // live native view (rec gone or its renderer was freed). This also avoids
        // resurrecting a cleared runtime entry for a just-deleted board (Bug #32).
        if (!recs.current.get(ev.id)?.exists) return
        // Respect a prior load-failed: a dead/refused URL loads a Chromium error page
        // whose own did-finish-load must not flip the board back to "connected"
        // (Bug #5). Main already latches `failed` and suppresses the emit in that
        // case; this is the renderer-side belt-and-suspenders — only promote to
        // connected from the in-flight `connecting` state, never override load-failed.
        const cur = usePreviewStore.getState().byId[ev.id]?.status
        if (cur === 'load-failed') return
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

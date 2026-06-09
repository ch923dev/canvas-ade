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
 *
 * This file is the imperative engine; `BrowserPreviewLayer.tsx` is a thin shell that
 * mounts it and returns `null`.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useReactFlow, useOnViewportChange } from '@xyflow/react'
import {
  roundRect,
  worldRectToScreen,
  rectsEqual,
  fitZoomFactorForBounds
} from '../../lib/cameraBounds'
import type { Rect } from '../../lib/cameraBounds'
import * as previewGeom from '../../lib/previewGeom'
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
   * Last reload nonce seen (previewStore). A push-to-preview bumps the nonce; reconcile
   * re-navigates when it changed even if `lastUrl` is identical — so a same-URL push
   * reloads (and can recover a load-failed view) instead of being diff-skipped (Bug #44).
   */
  lastReloadNonce: number
  /**
   * Bumped on every (re)attach. demoteToSnapshot snapshots this before its capture
   * await; if it changed when the await resolves, a concurrent attach re-claimed the
   * board (Bug #45) and the demote must not detach it.
   */
  attachSeq: number
}

export interface LayerProps {
  /** The React Flow pane element, for the paneOffset measurement (full-bleed). */
  paneRef: React.RefObject<HTMLDivElement | null>
  /**
   * The currently focused board id (double-click focus), or null. A native view
   * ignores the HTML dim-others, so while a focus is active every non-focused
   * Browser board demotes to its dimmable snapshot (see `liveEligible`).
   */
  focusedId: string | null
  /** The board currently in full view (its native view binds to the modal frame). */
  fullViewId: string | null
  /**
   * The full-view modal's portal host element (published by FullViewModal). The
   * full-view board's `.bb-frame` is portaled INTO this untransformed host; the native
   * view binds to that relocated frame's rect. We use it to GUARD `fullViewBoundsFor`:
   * only a `.bb-frame` contained by this host is the modal (untransformed) one — any
   * other read is the camera-scaled on-canvas frame and must be rejected.
   */
  fullViewHost: HTMLElement | null
  /**
   * The full-view modal frame is mid-transform (enter or exit tween, Slice 5). A CSS
   * `scale()` pollutes the `.bb-frame` rect the native view binds to, so HOLD the
   * full-view board's view detached for the tween and snap it in at settle.
   */
  fullViewMotion: boolean
  /**
   * Close the full-view modal. A focused native view's web content swallows keydown so
   * the renderer's window Esc handler never fires for a full-view Browser board — main
   * forwards an `escape` preview event (preview.ts before-input-event) and we invoke this
   * to exit, matching the Esc-exits-full-view behaviour terminals/notes already get.
   */
  onRequestCloseFullView: () => void
  /**
   * The "Project context" digest panel is open — a fixed full-height LEFT overlay
   * (`.digest-panel`, 300px). A native WebContentsView paints above ALL HTML, so a
   * Browser board whose stage overlaps the panel would cover it (the out-of-bounds bug).
   * While open, the panel's rect joins `chromeExclusionZones` so any overlapping live
   * view demotes to its (clippable, z-ordered) HTML snapshot. ADR 0002.
   */
  digestOpen: boolean
}

export function usePreviewManager(props: LayerProps): void {
  const {
    paneRef,
    focusedId,
    fullViewId,
    fullViewHost,
    fullViewMotion,
    onRequestCloseFullView,
    digestOpen
  } = props
  const { getViewport } = useReactFlow()
  const patchRuntime = usePreviewStore((s) => s.patch)
  // Patch ONLY an existing entry — for main-driven lifecycle events that may arrive
  // after a board was deleted, so they can't resurrect a cleared orphan (Bug #32).
  const patchRuntimeIfPresent = usePreviewStore((s) => s.patchIfPresent)
  const clearRuntime = usePreviewStore((s) => s.clear)
  // A board drag/resize is in progress (React Flow node-drag / NodeResizer). Unlike
  // a camera move it never fires useOnViewportChange, so we detach live views here.
  const nodeGesture = usePreviewStore((s) => s.nodeGesture)
  // A board ⋯ menu / device-overlapping popover is open. A native view paints above the
  // body-portaled menu, so suppress live views (→ HTML snapshot) the same way as a
  // gesture while the menu is open, then reattach on close. ADR 0002.
  const menuOpen = usePreviewStore((s) => s.menuOpen)

  // Live ref for the main-driven `escape` event handler so its subscription (below) need
  // not re-bind when the close callback identity changes. (The full-view id it checks
  // against has its own ref, kept in sync below.) Synced in an effect, not during render.
  const onCloseFullViewRef = useRef(onRequestCloseFullView)
  useEffect(() => {
    onCloseFullViewRef.current = onRequestCloseFullView
  }, [onRequestCloseFullView])

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
  // Boards that beginMotion is actively demoting (captured but not yet detached). The
  // per-frame flushBatch skips these so a view about to be pulled out is never trailed
  // with setBounds during the ~tens-of-ms capture window (the #43961 ghost trigger).
  const demoting = useRef<Set<string>>(new Set())
  const rafRef = useRef(0)
  const idleRef = useRef(0)
  // Latest focused board id, read inside the (geometry-only-deps) liveEligible cb.
  const focusedIdRef = useRef<string | null>(focusedId)
  // Latest full-view board id. When set, that board's native view binds to the
  // portaled modal device frame (live DOM rect) and every other view detaches.
  const fullViewIdRef = useRef<string | null>(fullViewId)
  // Latest modal portal host element. fullViewBoundsFor only accepts a `.bb-frame`
  // contained by this host (= the relocated, untransformed modal frame) so it never
  // reads the camera-scaled on-canvas rect (the full-view native-bounds bug).
  const fullViewHostRef = useRef<HTMLElement | null>(fullViewHost)
  // True while the modal frame is mid enter/exit tween — hold the full-view native view
  // detached (a frame scale pollutes the rect it binds to); attach at settle.
  const fullViewMotionRef = useRef<boolean>(fullViewMotion)
  // Latest store selection + the selected board's WORLD rect (any board type), kept
  // fresh by the store subscription. Used by the static-occlusion demote (LOT F #2/
  // #19/#20): a live Browser view overlapping a DIFFERENT selected board must demote
  // to its (clippable, z-ordered) HTML snapshot so that board shows its ring/handles
  // and receives input. Null when nothing — or a Browser board itself — is selected.
  const selectedIdRef = useRef<string | null>(null)
  const selectedRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  // Latest "Project context" digest-panel open state, read in occludesProtected (the
  // panel is a left overlay a native view must not paint over). Synced in the focus effect.
  const digestOpenRef = useRef<boolean>(digestOpen)

  const preset = useCallback((vp: BrowserViewport): ViewportPreset => VIEWPORT_PRESETS[vp], [])

  /** In full view, the native view binds to the portaled device frame's live DOM rect
   *  (the board's HTML frame is relocated into the modal; camera math no longer applies).
   *
   *  Returns null (caller HOLDS — never falls back to the canvas rect) UNLESS the
   *  `.bb-frame` is the one relocated INTO the modal host. The same `.bb-frame` element
   *  normally lives under `.react-flow__viewport` (CSS `translate()scale()`), so its
   *  `getBoundingClientRect()` is the CAMERA-SCALED CANVAS position — wrong for the modal.
   *  Only once `createPortal` has moved the subtree into the untransformed host does the
   *  rect become the true modal rect. The `host.contains(el)` guard accepts exactly that
   *  case and rejects the transform-polluted / pre-portal / LOD-card (no `.bb-frame`)
   *  reads, so the canvas rect is never sent in full view. */
  const fullViewBoundsFor = useCallback((id: string): Rect | null => {
    const host = fullViewHostRef.current
    if (!host) return null
    const el = document.querySelector<HTMLElement>(`[data-bb-frame="${id}"]`)
    if (!el || !host.contains(el)) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    // Inset by the 1px device-frame border so the unrounded native rect tucks INSIDE the
    // rounded HTML bezel — mirrors the on-canvas deviceStageRect inset. Two reasons it
    // matters in full view specifically: (1) the frame is flex-centred, so its left/width
    // are fractional and roundRect rounds x and width independently — round(x)+round(w) can
    // land 1px past the frame's right edge, letting the native page overflow the bezel on
    // the right; (2) without the inset the native view paints over the 1px border on every
    // edge. Insetting tucks it inside on all sides and absorbs the sub-pixel rounding.
    const border = 1
    return roundRect({
      x: r.left + border,
      y: r.top + border,
      width: Math.max(0, r.width - border * 2),
      height: Math.max(0, r.height - border * 2)
    })
  }, [])

  // The board's device-stage rect in screen (pane-local + offset) space — the raw,
  // un-rounded rect used for eligibility + viewport-distance ranking.
  const stageScreenRect = useCallback(
    (g: BoardGeom): Rect => previewGeom.stageScreenRect(g, getViewport(), paneOffset.current),
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

  // The chrome-exclusion zones for the CURRENT synchronous liveness pass: the fixed
  // app-chrome zones plus, while the "Project context" digest panel is open, its live DOM
  // rect. These are identical for every board within one applyLiveness/reconcile pass (the
  // pane geometry + panel rect don't change mid-pass), so resolve them ONCE per pass and
  // hand the result to each occludesProtected(g, chromeZones) call (was a querySelector +
  // getBoundingClientRect PER candidate board). Reads only refs + the DOM, returns Box[].
  const resolveChromeZones = useCallback((): Box[] => {
    const chromeZones = chromeExclusionZones({
      x: paneOffset.current.x,
      y: paneOffset.current.y,
      w: paneSize.current.w,
      h: paneSize.current.h
    })
    // The "Project context" digest panel is a fixed LEFT overlay (z-index above the
    // canvas) that a native view would paint over. While open, add its live DOM rect as
    // a chrome zone so an overlapping Browser view demotes to its HTML snapshot (the
    // out-of-bounds bug: the page bleeds left over the panel on pan). Read the rect (not
    // a hard-coded width) so it tracks the CSS; skip when off-screen (closed → the
    // translateX(-100%) rect sits at right<=pane left).
    if (digestOpenRef.current) {
      const el = document.querySelector('[data-test=digest-panel]')
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.right > paneOffset.current.x) {
          chromeZones.push({ x: r.left, y: r.top, width: r.width, height: r.height })
        }
      }
    }
    return chromeZones
  }, [])

  // Static-occlusion demote (LOT F): a live Browser view must fall back to its HTML
  // snapshot when, AT REST, its native stage would paint over (a) a DIFFERENT selected
  // board (#2/#19/#20 — restore that board's ring/handles + input) or (b) the fixed
  // app-chrome zones (#21 — dock / camera cluster / DiagOverlay). Geometry is resolved
  // to screen space here; the pure predicate decides. Kept narrow so a non-overlapping,
  // unselected live preview is never needlessly demoted (the e2e `browser` live guard).
  const occludesProtected = useCallback(
    (g: BoardGeom, chromeZones: Box[]): boolean => {
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
        lastReloadNonce: 0,
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
      const isFullView = fullViewIdRef.current === g.id
      const fv = isFullView ? fullViewBoundsFor(g.id) : null
      // HOLD: in full view, never fall back to the camera-scaled canvas rect. If the
      // portal hasn't relocated `.bb-frame` into the modal host yet (fv null), skip the
      // push — the board keeps its prior (pre-full-view) bounds for the 1–2 frames until
      // the portal lands, then the rAF pump snaps it to the modal rect. Falling back to
      // the camera-scaled canvas rect (the old `boundsFor`) here is what stranded the view
      // at its canvas position.
      if (isFullView && !fv) return
      // Read getViewport() once in the non-full-view branch and derive bounds + zoom from
      // the SAME rounded width (Bug #20) via boundsAndZoom — instead of boundsFor then
      // zoomFor, which recomputed boundsFor + re-read the camera. The full-view branch's
      // read count is unchanged (it never reads the camera).
      let bounds: Rect
      let zoomFactor: number
      if (fv) {
        bounds = fv
        zoomFactor = fitZoomFactorForBounds(fv.width, preset(g.viewport).w)
      } else {
        ;({ bounds, zoomFactor } = previewGeom.boundsAndZoom(g, getViewport(), paneOffset.current))
      }
      // Diff-skip a redundant re-attach: if the view is already attached at exactly
      // these bounds/zoom, re-issuing attachPreview re-adds the child view (a wasted
      // IPC + attachSeq bump for nothing). The new selection-driven applyLiveness
      // (LOT F) can call attachBoard on an already-correct live board, so this keeps
      // that a true no-op — mirrors the reconcile Bug #44 diff-skip. A genuine
      // move / re-attach (detached, or bounds/zoom changed) still falls through.
      // BUG-002: but NOT while beginMotion is mid-demote of this board (id in
      // `demoting` from before its capture/detach await until the finally drains it).
      // `r.attached` is still true then (beginMotion clears it only AFTER its detach IPC
      // resolves), so without this guard an endMotion→applyLiveness→attachBoard during
      // the await takes this no-op path: patches live:true but issues NO attachPreview
      // and does NOT bump attachSeq. beginMotion then detaches the view on main, while
      // its post-await write is skipped (seq unchanged, gestureRef now false) — leaving
      // the renderer state detached-but-live (frozen/blank board). Falling through here
      // issues a real attachPreview (re-attaching on main) AND bumps attachSeq, which
      // beginMotion's seq guard detects so it yields liveness to this re-attach.
      if (
        r.exists &&
        r.attached &&
        !demoting.current.has(g.id) &&
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
      const attachSeq = r.attachSeq
      if (r.exists) {
        void window.api.attachPreview({ id: g.id, bounds, zoomFactor })
      } else {
        r.exists = true
        r.lastUrl = g.url
        // openPreview loads g.url fresh, so adopt the current reload nonce here — else the
        // next reconcile (existing branch) would see a nonce mismatch and re-navigate the
        // url we just loaded (a redundant double-load).
        r.lastReloadNonce = usePreviewStore.getState().byId[g.id]?.reloadNonce ?? 0
        patchRuntime(g.id, { status: 'connecting', live: true })
        await window.api.openPreview({ id: g.id, url: g.url, bounds, zoomFactor })
        // Bug #48/#30: the board may have been deleted during the open IPC round-trip
        // (reconcile ran closeBoard + recs.delete + clearRuntime). Re-check existence
        // before the trailing live:true patch — otherwise previewStore.patch
        // (create-if-absent) resurrects a cleared entry with live:true, leaking it and
        // inflating the live-view count. Mirrors demoteToSnapshot / beginMotion.
        if (!recs.current.has(g.id)) return
        // ATTACH-1: a concurrent closeBoard (over-cap eviction / full-view tear-down /
        // gesture) can run DURING the open await — it clears r.attached/r.exists but does
        // NOT delete the rec, so the existence guard above passes. Re-patching live:true
        // here would resurrect a closed board in the store + DiagOverlay live-count. Bail
        // if we were closed (r.attached false) or a newer attach superseded us (seq bump).
        if (!r.attached || r.attachSeq !== attachSeq) return
      }
      patchRuntime(g.id, { live: true })
    },
    [rec, getViewport, fullViewBoundsFor, preset, patchRuntime]
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
    // Read the camera ONCE per frame and reuse it for every board (was getViewport() ×2
    // per board via boundsFor + zoomFor). boundsAndZoom derives both from one rounded
    // width (Bug #20).
    const vp = getViewport()
    for (const g of geomRef.current.values()) {
      const r = recs.current.get(g.id)
      if (!r || !r.attached) continue
      if (demoting.current.has(g.id)) continue // about to detach — don't trail it (#43961)
      const isFullView = fullViewIdRef.current === g.id
      const fv = isFullView ? fullViewBoundsFor(g.id) : null
      // HOLD (mirror of attachBoard): in full view, never push the camera-scaled canvas
      // rect. Until the portal relocates `.bb-frame` into the modal host (fv null), skip
      // this board so its view stays at its prior bounds rather than snapping to canvas.
      if (isFullView && !fv) continue
      let bounds: Rect
      let zoomFactor: number
      if (fv) {
        bounds = fv
        zoomFactor = fitZoomFactorForBounds(fv.width, preset(g.viewport).w)
      } else {
        // One boundsAndZoom call: computes the rounded bounds ONCE and derives zoom from
        // its width (Bug #20) — replaces the boundsFor()+zoomFor() pair that recomputed
        // boundsFor twice.
        ;({ bounds, zoomFactor } = previewGeom.boundsAndZoom(g, vp, paneOffset.current))
      }
      if (r.lastSent && rectsEqual(r.lastSent, bounds) && r.lastZoom === zoomFactor) continue
      r.lastSent = bounds
      r.lastZoom = zoomFactor
      items.push({ id: g.id, bounds, zoomFactor })
    }
    if (!items.length) return false
    void window.api.setPreviewBoundsBatch(items)
    return true
  }, [getViewport, fullViewBoundsFor, preset])

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
    // Mark every live board demoting BEFORE the capture await so flushBatch stops
    // repositioning the still-attached view during the capture window (the per-frame-
    // setBounds-then-detach #43961 trigger). Cleared at the end once detached.
    live.forEach((g) => demoting.current.add(g.id))
    void (async () => {
      // Bug H1: the just-added ids MUST always be drained from demoting.current — even
      // on the early gesture-abandon return below. If they leak, every later flushBatch
      // skips repositioning those boards' WebContentsViews forever (the `demoting.has`
      // guard at the top of flushBatch). try/finally guarantees the drain on all paths.
      try {
        // Bug #8/#9: capture per-board with a per-item guard so ONE rejected
        // capturePage() (headless / GPU-contended host) can't reject the whole batch and
        // abort every board's detach. A failed/empty capture resolves to null.
        const shots = await Promise.all(
          live.map((g) => window.api.capturePreview(g.id).catch(() => null))
        )
        if (!gestureRef.current) return // gesture ended before capture → keep live
        // Detach EVERY live native view for the gesture, even one whose capture came back
        // empty/failed (a blank/loading page, or a GPU-contended host). A native view
        // can't keep up with a fast NODE DRAG over IPC — it lags / appears stuck at the
        // old position — whereas the HTML snapshot (or the device-frame fallback) follows
        // the board pixel-perfect. A missing fresh snapshot just leaves the prior snapshot
        // / device frame; that brief staleness during a gesture is far better than a
        // trailing native layer. Fresh snapshot is applied only when one was captured.
        const detached: BoardGeom[] = []
        // Snapshot each board's attachSeq BEFORE the detach await so a concurrent
        // endMotion → applyLiveness → attachBoard reattach (which bumps attachSeq) is
        // detected below and not clobbered (Bug #15).
        const seqOf = new Map<string, number>()
        live.forEach((g, i) => {
          // Bug #48: a board deleted mid-capture had its rec removed + runtime cleared by
          // reconcile; patching here would resurrect an orphaned previewStore entry.
          if (!recs.current.has(g.id)) return
          if (shots[i]) patchRuntime(g.id, { snapshot: shots[i] })
          detached.push(g)
          seqOf.set(g.id, recs.current.get(g.id)!.attachSeq)
        })
        await Promise.all(detached.map((g) => window.api.detachPreview(g.id)))
        detached.forEach((g) => {
          const r = recs.current.get(g.id)
          // Bug #15/#48: skip the detach state-write if the board was removed (no rec),
          // a concurrent attachBoard re-claimed it (attachSeq bumped), or the gesture
          // already ended (endMotion now owns liveness) — otherwise we'd undo a reattach.
          if (!r || r.attachSeq !== seqOf.get(g.id) || !gestureRef.current) return
          r.attached = false
          patchRuntime(g.id, { live: false })
        })
      } finally {
        // Detach complete (or aborted) — always drop these ids so the pump may resume
        // positioning them; leaking them freezes their bounds updates forever (Bug H1).
        live.forEach((g) => demoting.current.delete(g.id))
      }
    })()
  }, [startPump, patchRuntime])

  // Recompute which boards should be live (zoom ≥ LOD, on-pane, focus, under the
  // cap) and reconcile each: attach the winners, CLOSE over-cap eligible boards
  // (free the renderer), demote the rest to snapshot. Shared by motion-end, node
  // gestures, and focus changes. Already-detached boards keep their image for a fast
  // reattach.
  const applyLiveness = useCallback((): void => {
    const all = [...geomRef.current.values()]
    const fvId = fullViewIdRef.current
    if (fvId) {
      // Full view: only the full-view Browser board may be live (bound to the modal
      // frame). Every OTHER native view must stop painting over the modal — but DETACH it
      // (snapshot-then-detach), NOT close it. closeBoard does a real webContents.close(),
      // which DISCARDS that board's navigated page state; on full-view EXIT the new-board
      // path then re-opens it at its persisted `board.url`, snapping it back from wherever
      // the user had navigated to the root URL (the full-view-resets-other-browser bug).
      // demoteToSnapshot captures an HTML fallback (shown on the canvas behind the scrim)
      // then detaches via detach() — whose setVisible(false)-before-removeChildView already
      // kills the Electron #44652 "second copy" ghost (the same path the node-drag detach
      // relies on), so the view leaves no stuck frame over the modal. The webContents stays
      // alive, so on EXIT applyLiveness (non-full-view path) re-ATTACHES it (attachPreview,
      // no loadURL) with its page state intact. The full-view rAF pump only ever touches
      // fvId, so detaching the OTHER boards here can't race it.
      for (const g of all) {
        if (g.id === fvId) {
          // Slice 5: while the modal frame is mid-transform a CSS scale() pollutes the rect
          // the native view binds to, so HOLD this view DETACHED for the tween and snap it
          // in at settle. DETACH (snapshot-then-detach) — never close: a webContents.close()
          // here discards the page, so on settle attachBoard re-OPENs it at board.url and the
          // user's navigated page snaps back to the root (full-viewing restarts the board —
          // and again on the exit tween). A detach keeps the webContents alive, so attachBoard
          // re-attaches it (attachPreview, no loadURL) at the modal/canvas rect, state intact.
          if (fullViewMotionRef.current) {
            if (rec(g.id).attached) void demoteToSnapshot(g)
          } else void attachBoard(g)
        } else if (rec(g.id).attached) void demoteToSnapshot(g) // detach (keep webContents)
      }
      return
    }
    // A board may go live only if base-eligible (zoom/on-pane/focus) AND not statically
    // occluding a selected board or the app chrome (LOT F #2/#19/#20/#21). The
    // occlusion-demoted set keeps its renderer + snapshot for a fast reattach once the
    // overlap clears (handled in the else-branch, like LOD), so it is NOT closed.
    // Resolve the chrome-exclusion zones ONCE for this pass (identical for every board),
    // then reuse them across the filter below (was rebuilt per candidate board).
    const chromeZones = resolveChromeZones()
    const wantLive = all.filter((g) => liveEligible(g) && !occludesProtected(g, chromeZones))
    // Bug L3: O(1) membership for the per-board loop below (was wantLive.includes → O(n²)).
    const wantLiveIds = new Set(wantLive.map((g) => g.id))
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
      else if (wantLiveIds.has(g.id)) {
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
    resolveChromeZones,
    stageScreenRect,
    rec,
    attachBoard,
    closeBoard,
    demoteToSnapshot
  ])

  // onMoveEnd: clear the gesture flag, then reconcile liveness at the rest position.
  const endMotion = useCallback((): void => {
    // Bug #2: endMotion is driven by BOTH the camera path (useOnViewportChange.onEnd)
    // and the node-gesture effect below. React Flow auto-pans the camera when a node is
    // dragged to a pane edge; that programmatic pan fires onEnd → endMotion WHILE the
    // node drag is still in progress, reattaching the always-above native views and
    // re-occluding the dragged board mid-drag. Ignore a camera-driven end while a node
    // gesture is active — the node-drag's own end (nodeGesture → false) stays the sole
    // authority that finally clears the flag and reattaches.
    if (usePreviewStore.getState().nodeGesture) return
    gestureRef.current = false
    applyLiveness()
  }, [applyLiveness])

  useOnViewportChange({ onStart: beginMotion, onChange: startPump, onEnd: endMotion })

  // ── Node drag/resize gestures + ⋯-menu open + focus changes (no camera move → no
  // viewport event) ──
  // A node drag/resize START — or an open board ⋯ menu — detaches every live view → HTML
  // snapshot (so a board dragged over a live Browser board, or a menu dropping over one,
  // isn't occluded by its always-above native layer); the gesture/menu END reattaches the
  // eligible ones. Skip the initial mount tick (both flags are already false). begin/
  // endMotion are stable (deps don't include the flags), so this effect runs on real
  // toggles; re-running on a rare callback-identity change is safe (begin guards on
  // gestureRef, end is idempotent).
  const gestureMounted = useRef(false)
  useEffect(() => {
    if (!gestureMounted.current) {
      gestureMounted.current = true
      return
    }
    if (nodeGesture || menuOpen) beginMotion()
    else endMotion()
  }, [nodeGesture, menuOpen, beginMotion, endMotion])

  // Focus change → re-evaluate liveness (focused board stays live, others demote to
  // their dimmable snapshot). Focus also fits the camera (→ onMoveEnd already
  // reconciles), but UNFOCUS via Esc moves no camera, so re-apply here too.
  const focusMounted = useRef(false)
  useEffect(() => {
    focusedIdRef.current = focusedId
    fullViewIdRef.current = fullViewId
    fullViewHostRef.current = fullViewHost
    fullViewMotionRef.current = fullViewMotion
    // Opening/closing the Project-context panel changes which boards it occludes, so
    // re-reconcile liveness (demote a now-covered live view; restore it on close).
    digestOpenRef.current = digestOpen
    if (!focusMounted.current) {
      focusMounted.current = true
      return
    }
    // A motion flip (enter settled / exit started) re-reconciles: detach the full-view
    // view while the frame transforms, attach it once settled (Slice 5 hold-then-snap).
    applyLiveness()
  }, [focusedId, fullViewId, fullViewHost, fullViewMotion, digestOpen, applyLiveness])

  // Full view: the camera never moves, so the camera-driven rAF pump (startPump, fired
  // by useOnViewportChange) never runs — yet the full-view board's native bounds must
  // (a) correct themselves once the portal relocates `.bb-frame` from the canvas into
  // the modal a couple render cycles after open (applyLiveness above attaches with the
  // still-on-canvas rect), and (b) follow the modal frame across window resizes. Drive a
  // dedicated rAF that re-pushes bounds (flushBatch reads the live `.bb-frame` DOM rect
  // via fullViewBoundsFor and diff-skips once stable) for as long as a board is full-view.
  useEffect(() => {
    if (!fullViewId) return
    let raf = 0
    // Bug L4: self-terminate once settled — without this the pump ran a
    // getBoundingClientRect (fullViewBoundsFor) + flushBatch EVERY frame for the entire
    // full-view session. Mirror startPump's idle-frame counter: a frame is "active" if
    // it (re)attached the held view OR flushBatch pushed an update; after ~4 idle frames
    // the loop stops. A window resize or a motion settle re-arms it (re-runs the pump).
    let idle = 0
    const tick = (): void => {
      let active = false
      // Skip while the modal frame is mid enter/exit tween (Slice 5) — the held view must
      // not attach to a scale-polluted rect; applyLiveness reattaches it at settle. Keep
      // pumping (don't idle out) through the tween so we resume promptly at settle.
      if (!fullViewMotionRef.current) {
        // The full-view board's native view may not be attached yet — the initial
        // applyLiveness attach is HELD until the portal relocates `.bb-frame` into the
        // modal host (fullViewBoundsFor null → attachBoard early-returns). Once the host
        // is ready, re-issue the attach here so the (held) view comes live at the modal
        // rect; flushBatch (attached-only) then keeps it pinned across window resizes.
        const g = geomRef.current.get(fullViewId)
        if (g && !recs.current.get(fullViewId)?.attached) {
          void attachBoard(g)
          active = true
        }
        if (flushBatch()) active = true
      } else {
        active = true // mid-tween: stay armed so settle is caught immediately
      }
      idle = active ? 0 : idle + 1
      raf = idle < 4 ? requestAnimationFrame(tick) : 0
    }
    const arm = (): void => {
      idle = 0
      if (!raf) raf = requestAnimationFrame(tick)
    }
    arm()
    // A window resize moves the modal frame's DOM rect with no React re-render → re-arm
    // the (possibly idled-out) pump so the native view re-pins to the new rect.
    window.addEventListener('resize', arm)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', arm)
    }
  }, [fullViewId, flushBatch, attachBoard])

  // ── Reconcile the native views with the store's Browser boards ────────────────
  // Subscribe imperatively (NOT via a hook selector that re-renders) so geometry +
  // url + viewport changes update the views without re-rendering this layer.
  const reconcile = useCallback(
    (boards: BoardGeom[]): void => {
      const seen = new Set(boards.map((g) => g.id))
      geomRef.current = new Map(boards.map((g) => [g.id, g]))
      // Read the camera ONCE for this pass; the attached-board re-push block below reuses
      // it via boundsAndZoom (was getViewport() ×2 per board via boundsFor + zoomFor).
      const vp = getViewport()
      // Resolve the chrome-exclusion zones ONCE for this pass; the new-board occlusion
      // guard below reuses them for every board (was a querySelector + getBoundingClientRect
      // rebuilt per new board inside occludesProtected).
      const chromeZones = resolveChromeZones()

      // Removed boards: close + clear runtime.
      for (const id of [...recs.current.keys()]) {
        if (!seen.has(id)) {
          closeBoard(id)
          recs.current.delete(id)
          clearRuntime(id)
        }
      }

      // Bug M1: count the views already live ONCE before the pass (O(n), not O(n²)).
      // Only the new-board branch below attaches within this loop (the r.exists branch
      // never closes a board here), so incrementing on each attach keeps the count exact.
      let liveNow = 0
      for (const rr of recs.current.values()) if (rr.attached) liveNow++

      for (const g of boards) {
        const r = rec(g.id)
        if (!r.exists && !r.attached) {
          // New board (or one whose renderer was freed): bring it live if eligible AND
          // not statically occluding a selected board / the app chrome (LOT F).
          // Bug #4: while another board is in full view, a non-full-view Browser must
          // stay closed — otherwise a store mutation (e.g. a note drag in the full-view
          // board) re-runs reconcile and re-attaches the Browser at its canvas rect,
          // painting the always-above native view over the modal scrim.
          const fvId = fullViewIdRef.current
          const blockedByFullView = fvId !== null && fvId !== g.id
          // Bug M1: enforce the MAX_LIVE cap on the CREATION path. reconcile is the
          // sole driver for brand-new boards (the subscribe-side applyLiveness only
          // fires on selChanged || fullView), so without this guard N eligible boards
          // created in one tick all go live, blowing past the cap. Count the views
          // already live this pass and stop attaching once the cap is reached; a freed
          // slot (LOD / move-end → applyLiveness, which honours the cap) brings the
          // held boards live later.
          if (
            !blockedByFullView &&
            liveNow < MAX_LIVE &&
            liveEligible(g) &&
            !occludesProtected(g, chromeZones)
          ) {
            void attachBoard(g)
            liveNow++
          }
          // Bug #3: a board created below LOD / off-pane isn't yet eligible, so it
          // would otherwise sit on the dead idle default (empty stage, no label)
          // until a later zoom gesture attaches it. Show the 'Connecting…'
          // placeholder so it doesn't read as broken; endMotion/reconcile will
          // attach + load it once it becomes eligible.
          else if ((usePreviewStore.getState().byId[g.id]?.status ?? 'idle') === 'idle')
            patchRuntime(g.id, { status: 'connecting' })
        } else if (r.exists) {
          // URL edit → navigate (resets zoom; did-finish-load re-applies the factor).
          // Also re-navigate on a reload-nonce bump (push-to-preview) even when the url is
          // UNCHANGED — a same-URL push must reload, e.g. to recover a load-failed view once
          // the dev server is up. Diff-skip is otherwise preserved (Bug #44): an unrelated
          // store mutation leaves both url and nonce unchanged → no redundant navigate.
          const nonce = usePreviewStore.getState().byId[g.id]?.reloadNonce ?? 0
          if (g.url !== r.lastUrl || nonce !== r.lastReloadNonce) {
            r.lastUrl = g.url
            r.lastReloadNonce = nonce
            patchRuntime(g.id, { status: 'connecting' })
            void window.api.navigatePreview(g.id, g.url)
          }
          // Viewport / geometry change → re-push bounds + zoom for attached boards.
          // Bug #44: diff-skip an unchanged board (mirrors flushBatch) so a store
          // mutation on ANOTHER board (drag, select, setTool) doesn't fire a
          // redundant preview:attach IPC for every already-positioned view.
          // Bug #10: while a node/camera gesture is in flight, the motion paths own
          // bounds — re-pushing here every drag tick re-shows a detached view mid-drag
          // (the per-frame-setBounds-then-detach #43961 trigger). Bail during a gesture.
          if (r.attached && !gestureRef.current) {
            const { bounds, zoomFactor } = previewGeom.boundsAndZoom(g, vp, paneOffset.current)
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
      resolveChromeZones,
      attachBoard,
      getViewport,
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

    // Initial sync, then on every store change. The reconcile is gated on the BOARDS slice:
    // camera pan/zoom fires setViewport every frame, which leaves the `boards` array
    // reference untouched — so a viewport-only change skips the per-frame toGeom + reconcile
    // and we re-run it only when board geometry actually changes (#perf —
    // previewlayer-reconcile-on-every-viewport-frame). Selection + full-view liveness still
    // re-evaluate on every change.
    const initial = useCanvasStore.getState()
    syncSelection(initial)
    reconcile(toGeom(initial.boards))
    let prevBoards = initial.boards
    const unsub = useCanvasStore.subscribe((s) => {
      const selChanged = syncSelection(s)
      if (s.boards !== prevBoards) {
        prevBoards = s.boards
        reconcile(toGeom(s.boards))
      }
      // Selection (or the selected board's geometry) changed but no camera/node gesture
      // is in flight → re-evaluate static occlusion so an already-attached Browser view
      // demotes (or reattaches) against the new selection. Geometry-driven changes are
      // already handled by reconcile's bounds re-push + the gesture/move paths.
      // Bug #4: while a board is in full view, ANY mutation (a note drag, etc.) must also
      // re-run the full-view-aware applyLiveness so a freshly-reconciled Browser is closed
      // back down rather than left painting over the modal scrim.
      if ((selChanged || fullViewIdRef.current !== null) && !gestureRef.current) applyLiveness()
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
      // Esc pressed while the native view's web content owns focus (main forwards it via
      // before-input-event). The renderer window never receives this keydown, so close
      // full view here when the event's board is the full-view one — parity with the
      // window Esc handler that already exits full view for terminals/notes.
      if ((ev.type as string) === 'escape') {
        if (ev.id === fullViewIdRef.current) onCloseFullViewRef.current()
        return
      }
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
        // Bug #32: patch ONLY if the entry still exists — an in-flight nav event that
        // arrives after the board was deleted must not resurrect a cleared orphan.
        patchRuntimeIfPresent(ev.id, {
          liveUrl: ev.url,
          canGoBack: ev.canGoBack,
          canGoForward: ev.canGoForward
        })
      } else if (ev.type === 'did-fail-load') {
        patchRuntimeIfPresent(ev.id, { status: 'load-failed', error: ev.errorDescription })
      }
    })
    return off
  }, [patchRuntime, patchRuntimeIfPresent])

  // Tear down on unmount (HMR / route change): stop the pump + close every view.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void window.api.closeAllPreviews()
    },
    []
  )
}

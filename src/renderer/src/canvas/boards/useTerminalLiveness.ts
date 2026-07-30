import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useReactFlow, useStoreApi } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { useTerminalLivenessStore } from '../../store/terminalLivenessStore'
import { useDockStore } from '../../store/dockStore'
import type { Board, TerminalBoard } from '../../lib/boardSchema'
import { worldRectToScreen } from '../../lib/cameraBounds'
import { isOsrVisible } from '../../lib/osrLiveness'
import { LOD_ZOOM } from '../../lib/canvasView'
import { usePaneRect } from './usePaneRect'

/**
 * Debounce a camera settle: a continuous pan/zoom keeps resetting the timer, so the reconcile
 * fires only once the camera comes to rest (the additive analogue of React Flow's onViewportChange
 * `onEnd`, which we MUST NOT use — it is a single-slot store field already owned by the OSR
 * liveness manager; a second consumer would clobber it, see Canvas.tsx). 120ms is well under any
 * perceptible delay yet long enough to coalesce a gesture.
 */
const TERMINAL_SETTLE_MS = 120

/**
 * Terminal-crisp umbrella, Lane A — the Terminal-board LIVENESS manager (xterm #880 fix).
 *
 * Mounted ONCE in CanvasInner. Each settle / board change it decides, per Terminal board, whether
 * it is on-screen ∧ at-or-above LOD (`osrLiveness.isOsrVisible`, reused — the visibility maths is
 * board-type agnostic) and publishes the flag to `terminalLivenessStore`. `useTerminalSpawn` reads
 * its own flag to gate its write coalescer: a gated terminal HOLDS incoming PTY data (its session
 * stays fully alive — only rendering pauses) and flushes losslessly when it returns to view.
 *
 * This is the direct twin of `useOffscreenLiveness` with two simplifications:
 *   - NO existence/MAX_LIVE cap — a hidden terminal costs only held bytes (bounded by the
 *     coalescer's scrollback cap), not a renderer process, so there is nothing to evict.
 *   - the camera trigger is an ADDITIVE React Flow store `transform` subscription (debounced to a
 *     settle), NOT `useOnViewportChange` — the latter is single-slot and owned by OSR. The raw
 *     store subscription is also more reliable for programmatic (duration-0) camera moves.
 *
 * Reconcile triggers (mirroring OSR): a debounced camera settle; the canvasStore `boards`-ref
 * change (add/remove/geometry — a drag mutates geometry per frame, but the publish is diff-skipped
 * so a no-flip frame writes nothing); and a PORTAL full-view enter/exit (a full-viewed terminal is
 * shown in the modal regardless of where its canvas node sits, so it is forced live — else its
 * session would freeze while maximised).
 */
export function useTerminalLiveness(
  paneRef: RefObject<HTMLDivElement | null>,
  fullViewId: string | null
): void {
  const { getViewport } = useReactFlow()
  const storeApi = useStoreApi()
  // R6: the pane box, measured on resize rather than re-read per reconcile — this hook runs on
  // every `boards`-ref change, so the old getBoundingClientRect() here was a forced layout per
  // drag frame (audit P-2).
  const getPaneRect = usePaneRect(paneRef)
  // Last published map, for diff-skip (only a CHANGED map is written to the store).
  const sentRef = useRef<Record<string, boolean>>({})
  // The PORTAL full-viewed board, read inside the (stable) reconcile so it isn't a dep.
  const fullViewIdRef = useRef<string | null>(fullViewId)

  const reconcile = useCallback((): void => {
    const pane = getPaneRect()
    if (!pane) return
    const vp = getViewport()
    const paneOffset = { x: pane.x, y: pane.y }
    const paneBox = pane
    const fvId = fullViewIdRef.current
    const allBoards = useCanvasStore.getState().boards
    const boards = allBoards.filter((b): b is TerminalBoard => b.type === 'terminal')
    const dockActive = useDockStore.getState().active

    // Visibility of one board's CANVAS rect (shared by the plain path and the dock-host path).
    const rectVisible = (b: Board): boolean => {
      const screen = worldRectToScreen({ x: b.x, y: b.y, width: b.w, height: b.h }, vp, paneOffset)
      return isOsrVisible({ screen, pane: paneBox, zoom: vp.zoom, lod: LOD_ZOOM })
    }

    const next: Record<string, boolean> = {}
    for (const b of boards) {
      // Swarm docked-terminals: a docked worker has NO canvas node — its own x/y are stale
      // parking coordinates — so visibility is its HOST swarm board's rect, and only the
      // ACTIVE dock tab renders (inactive tabs hold bytes exactly like an off-screen board).
      // A dangling host reads not-live (nothing can be painting it); the fromObject/applier
      // reconciles clear the flag, this just refuses to mark an unreachable surface live.
      if (b.dockedIn) {
        const host = allBoards.find((h) => h.id === b.dockedIn && h.type === 'swarm')
        next[b.id] =
          host !== undefined &&
          dockActive[host.id] === b.id &&
          (host.id === fvId || rectVisible(host))
        continue
      }
      // A PORTAL-full-viewed terminal renders in the modal no matter where its canvas node sits —
      // force it live so its PTY output keeps painting (else maximising an off-screen/below-LOD
      // terminal would show a frozen modal). Otherwise: on-screen ∧ ≥ LOD.
      next[b.id] = b.id === fvId || rectVisible(b)
    }

    // Diff-skip: only write when the live map actually changed (no store churn on a no-flip settle,
    // and the spawn-side subscription stays quiet → no needless ref writes).
    const prev = sentRef.current
    const ids = Object.keys(next)
    let changed = ids.length !== Object.keys(prev).length
    if (!changed) {
      for (const id of ids) {
        if (prev[id] !== next[id]) {
          changed = true
          break
        }
      }
    }
    if (changed) {
      sentRef.current = next
      useTerminalLivenessStore.getState().setLive(next)
    }
  }, [getViewport, getPaneRect])

  // Camera settle — additive RF-store `transform` subscription, debounced (see TERMINAL_SETTLE_MS).
  // ADDITIVE on purpose: any number of subscribers can ride the RF store transform (Canvas already
  // does for autosave), unlike the single-slot useOnViewportChange the OSR manager owns.
  useEffect(() => {
    let timer = 0
    let prev: readonly [number, number, number] | null = null
    const unsub = storeApi.subscribe((s) => {
      const t = s.transform
      if (prev && t[0] === prev[0] && t[1] === prev[1] && t[2] === prev[2]) return
      prev = t
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(reconcile, TERMINAL_SETTLE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [storeApi, reconcile])

  // Board geometry / membership changes + the initial reconcile.
  useEffect(() => {
    reconcile()
    let prevBoards = useCanvasStore.getState().boards
    return useCanvasStore.subscribe((s) => {
      if (s.boards !== prevBoards) {
        prevBoards = s.boards
        reconcile()
      }
    })
  }, [reconcile])

  // Full-view enter/exit: neither the camera nor the boards array changes, so the two triggers
  // above miss it — re-gate explicitly (force the full-viewed terminal live; exit re-derives it).
  useEffect(() => {
    fullViewIdRef.current = fullViewId
    reconcile()
  }, [fullViewId, reconcile])

  // Swarm docked-terminals: a dock tab switch changes which docked worker renders without
  // touching the camera or the boards array — reconcile on the dock selection too, so the
  // newly-active tab flushes its held bytes and the deactivated one starts holding.
  useEffect(() => {
    let prev = useDockStore.getState().active
    return useDockStore.subscribe((s) => {
      if (s.active !== prev) {
        prev = s.active
        reconcile()
      }
    })
  }, [reconcile])
}

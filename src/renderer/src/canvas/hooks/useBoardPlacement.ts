/**
 * Drag-to-create board placement (redesign 2026-06-06). Armed ≡ the store `tool` is a
 * board type (the dock sets it; see AppChrome.Dock). While armed, Canvas renders a
 * transparent capture overlay whose `onPointerDown` is `startPlacement`:
 *   - drag ≥5px  → a board sized to the dragged rect (world coords, min-clamped), placed exact
 *   - click <5px → a default-size board centered on the cursor (freeSlot-nudged)
 * Either way the tool reverts to 'select'. Esc, window blur, pointercancel, or unmount
 * ABORTS an in-flight drag so a late pointerup can't create a phantom board after cancel;
 * only the primary button (e.button === 0) starts one. The ghost is a screen-space rect
 * (client coords) the overlay draws; world conversion happens only on release.
 *
 * Pointer model mirrors Canvas.tsx's connector rubber-band: pointerdown arms a window
 * pointermove/pointerup pair, removed on release; a cleanup ref lets Esc/unmount tear the
 * same pair down. No per-frame store writes (only local ghost state moves each move).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { DEFAULT_BOARD_SIZE, type BoardType } from '../../lib/boardSchema'
import { isClickGesture, normalizeBox, placementRect, type Box } from '../../lib/placement'
import { resolveConnectTarget } from '../../lib/resolveConnectTarget'

export interface BoardPlacementApi {
  /** True while a board type is armed (capture overlay should mount). */
  armed: boolean
  /**
   * Placement gesture for the armed tool. 'drag' = press→drag→release rubber-band (terminal /
   * browser / planning, via startPlacement). 'follow' = the Command board's place-to-create — a
   * fixed-size ghost follows the cursor and a single click plants it (followMove + followPlace).
   */
  placeMode: 'drag' | 'follow'
  /** Screen-space ghost rect (client coords): the drag rubber-band, or the follow footprint. */
  ghost: Box | null
  /** Capture overlay's `onPointerDown` (drag mode). */
  startPlacement: (e: ReactPointerEvent) => void
  /** Capture overlay's `onPointerMove` (follow mode): move the fixed-size ghost under the cursor. */
  followMove: (e: ReactPointerEvent) => void
  /** Capture overlay's `onClick` (follow mode): plant the Command board centered on the cursor. */
  followPlace: (e: ReactMouseEvent) => void
  /** Cancel follow mode without placing (right-click / contextmenu / programmatic). */
  cancelPlacement: () => void
}

export function useBoardPlacement(rf: ReactFlowInstance): BoardPlacementApi {
  const tool = useCanvasStore((s) => s.tool)
  const setTool = useCanvasStore((s) => s.setTool)
  const setSelection = useCanvasStore((s) => s.setSelection)
  const armed = tool !== 'select'
  // The Command board uses place-to-create (a fixed-size ghost that follows the cursor, click to
  // plant); the other board types keep the press→drag→release rubber-band.
  const placeMode: 'drag' | 'follow' = tool === 'command' ? 'follow' : 'drag'
  const [ghost, setGhost] = useState<Box | null>(null)
  // Removes the in-flight drag's window listeners; set while a drag is live, else null.
  const dragCleanupRef = useRef<(() => void) | null>(null)

  const abortDrag = useCallback((): void => {
    dragCleanupRef.current?.()
    dragCleanupRef.current = null
    setGhost(null)
  }, [])

  // Esc cancels while armed: abort any in-flight drag (so a late pointerup can't commit) + disarm.
  // Uses CAPTURE phase so it fires even when another capture-phase listener (e.g. the full-view
  // exit in useCanvasKeybindings) calls stopPropagation() — both capture listeners on the same
  // target (window) run regardless of each other's stopPropagation (only stopImmediatePropagation
  // would suppress a sibling; stopPropagation only prevents descent/bubbling).
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        abortDrag()
        setTool('select')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armed, setTool, abortDrag])

  // Safety net: tear down a live drag if the hook unmounts mid-gesture.
  useEffect(() => () => abortDrag(), [abortDrag])

  // The Command board is a SINGLETON: arming it when one already exists must NOT enter place mode
  // (a following ghost would imply you could plant a second). Re-select the existing orchestrator
  // and disarm immediately — ghost-free — the Option-B "the +Command affordance jumps to it".
  useEffect(() => {
    if (!armed || tool !== 'command') return
    const existing = useCanvasStore.getState().boards.find((b) => b.type === 'command')
    if (existing) {
      setSelection([existing.id])
      setTool('select')
    }
  }, [armed, tool, setSelection, setTool])

  // Command place-to-create — the ghost is the board's FIXED footprint scaled to the live zoom,
  // centered on the cursor; it tracks pointermove with no button held (no rubber-band, no resize).
  const followMove = useCallback(
    (e: ReactPointerEvent): void => {
      if (tool !== 'command') return
      const zoom = rf.getZoom()
      const w = DEFAULT_BOARD_SIZE.command.w * zoom
      const h = DEFAULT_BOARD_SIZE.command.h * zoom
      setGhost({ x: e.clientX - w / 2, y: e.clientY - h / 2, w, h })
    },
    [tool, rf]
  )

  // A single primary click plants the board with its CENTER at the cursor, placed `exact` (the
  // user chose the spot — no freeSlot nudge), then disarms. addBoard's singleton guard is the
  // backstop if one somehow exists (the effect above normally disarms before we reach here).
  const followPlace = useCallback(
    (e: ReactMouseEvent): void => {
      if (tool !== 'command' || e.button !== 0) return
      const size = DEFAULT_BOARD_SIZE.command
      const pt = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      useCanvasStore
        .getState()
        .addBoard('command', { x: pt.x - size.w / 2, y: pt.y - size.h / 2 }, { exact: true })
      setGhost(null)
      setTool('select')
    },
    [tool, rf, setTool]
  )

  // Right-click (or programmatic) cancel for follow mode — disarm without planting. Esc is
  // already handled by the armed keydown effect above.
  const cancelPlacement = useCallback((): void => {
    setGhost(null)
    setTool('select')
  }, [setTool])

  const startPlacement = useCallback(
    (e: ReactPointerEvent): void => {
      if (tool === 'select') return
      // BUG-046: only the primary button places a board — a right/middle press would
      // otherwise arm the window pointerup pair and commit a phantom board on release.
      if (e.button !== 0) return
      // BUG-035: If a drag is already in flight (e.g. two-finger touch producing two concurrent
      // pointerdown events), abort the previous drag before starting a new one so its window
      // listeners are not orphaned.
      if (dragCleanupRef.current) abortDrag()
      const type = tool as BoardType
      const sx = e.clientX
      const sy = e.clientY
      setGhost({ x: sx, y: sy, w: 0, h: 0 })

      const onMove = (ev: PointerEvent): void => {
        setGhost(normalizeBox(sx, sy, ev.clientX, ev.clientY))
      }
      const onUp = (ev: PointerEvent): void => {
        abortDrag() // removes these listeners + clears the ghost
        const add = useCanvasStore.getState().addBoard
        // A user-placed terminal opens the New Terminal dialog (place-first flow): its spawn
        // is held until the dialog resolves. Browser/Planning place + render immediately.
        const configPending = type === 'terminal'
        if (isClickGesture(ev.clientX - sx, ev.clientY - sy)) {
          const pt = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
          const size = DEFAULT_BOARD_SIZE[type]
          add(type, { x: pt.x - size.w / 2, y: pt.y - size.h / 2 }, { exact: false, configPending })
        } else {
          const a = rf.screenToFlowPosition({
            x: Math.min(sx, ev.clientX),
            y: Math.min(sy, ev.clientY)
          })
          const b = rf.screenToFlowPosition({
            x: Math.max(sx, ev.clientX),
            y: Math.max(sy, ev.clientY)
          })
          const r = placementRect(a, b)
          add(type, { x: r.x, y: r.y }, { size: { w: r.w, h: r.h }, exact: true, configPending })
        }
        setTool('select')
      }
      // BUG-047: a pointercancel (touch/pen) or an OS focus steal mid-drag (Alt+Tab — the
      // pointerup goes to the other app) skips window pointerup, leaving these listeners
      // armed; the NEXT pointerup anywhere (even on chrome above the overlay) would commit
      // a phantom board from the stale origin. Abort the drag like Esc does (tool stays
      // armed — only the in-flight gesture is cancelled).
      const onCancel = (): void => abortDrag()
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('blur', onCancel)
      dragCleanupRef.current = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('blur', onCancel)
      }
    },
    [tool, rf, setTool, abortDrag]
  )

  return { armed, placeMode, ghost, startPlacement, followMove, followPlace, cancelPlacement }
}

/**
 * M2 connector rubber-band drag (the placement gesture's documented sibling — moved here
 * from Canvas.tsx so both window-pointer creation gestures share one home + the abort
 * discipline above). While `connectFromId` is set (title-bar connector handle pressed),
 * window listeners track the pointer for the rubber-band and, on release, resolve the
 * drop target from STORE GEOMETRY (pure resolveConnectTarget — no DOM hit-test) → add an
 * orchestration connector. Window-level so the drag resolves past the board edge.
 *
 * BUG-048: Esc (CAPTURE phase, same rationale as the placement Esc above), window blur
 * (an OS focus steal swallows the pointerup), or pointercancel ABORTS without committing —
 * otherwise the armed listeners survive and the next pointerup over a board (e.g. the
 * user's re-focusing click) silently commits a connector.
 */
export function useConnectorDrag(opts: {
  rf: ReactFlowInstance
  connectFromId: string | null
  setConnectFromId: (id: string | null) => void
  setConnectPointer: (p: { x: number; y: number } | null) => void
  addConnector: (sourceId: string, targetId: string, kind: 'orchestration') => string | null
}): void {
  const { rf, connectFromId, setConnectFromId, setConnectPointer, addConnector } = opts
  useEffect(() => {
    if (!connectFromId) return
    const onMove = (e: PointerEvent): void => setConnectPointer({ x: e.clientX, y: e.clientY })
    const onUp = (e: PointerEvent): void => {
      const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const target = resolveConnectTarget(useCanvasStore.getState().boards, connectFromId, flow)
      if (target) addConnector(connectFromId, target, 'orchestration')
      setConnectFromId(null)
      setConnectPointer(null)
    }
    const abort = (): void => {
      setConnectFromId(null)
      setConnectPointer(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') abort()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('blur', abort)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', abort)
      window.removeEventListener('blur', abort)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [connectFromId, rf, addConnector, setConnectFromId, setConnectPointer])
}

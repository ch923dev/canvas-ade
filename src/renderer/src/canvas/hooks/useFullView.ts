/**
 * Full-view state machine, extracted from Canvas.tsx (Wave-5 B5 #3). Co-locates the two
 * mutually-exclusive full-view modes and their motion flags:
 *   • PORTAL full view (browser/terminal) — relocates the live board subtree into the modal
 *     host so the session survives; `fullViewId` stays set through the exit fade.
 *   • CAMERA full view (planning) — a camera fit under the single parent camera (no portal);
 *     the prior viewport is saved on enter and restored on exit.
 * Behavior-preserving: every callback body + ref/effect is moved verbatim. Stateful glue with
 * no pure seam — covered by fullview.e2e.ts (relocation / detach-not-close / Esc) end-to-end.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { ReactFlowInstance, Viewport } from '@xyflow/react'
import { cameraAnim } from '../../lib/motion'
import { Z_MAX } from '../../lib/canvasView'

/** Planning "full view" fits TIGHTER than focus (fills more of the viewport). It's a CAMERA fit
 *  (Option A), not the portal modal — vector content re-rasterises crisp at any zoom, so Z_MAX. */
const FULLVIEW_OPTIONS = { padding: 0.1, maxZoom: Z_MAX } as const

export interface FullViewDeps {
  rf: ReactFlowInstance
  selectBoard: (id: string | null) => void
}

export interface FullViewApi {
  fullViewId: string | null
  fullViewHost: HTMLElement | null
  fullViewClosing: boolean
  fullViewMotion: boolean
  cameraFullViewId: string | null
  setFullViewId: Dispatch<SetStateAction<string | null>>
  setFullViewHost: Dispatch<SetStateAction<HTMLElement | null>>
  setCameraFullViewId: Dispatch<SetStateAction<string | null>>
  fullViewIdRef: MutableRefObject<string | null>
  cameraFullViewIdRef: MutableRefObject<string | null>
  openFullView: (id: string) => void
  closeFullView: () => void
  hardCloseFullView: () => void
  handleFullViewEntered: () => void
  handleFullViewExited: () => void
  enterCameraFullView: (id: string) => void
  exitCameraFullView: () => void
}

export function useFullView(deps: FullViewDeps): FullViewApi {
  const { rf, selectBoard } = deps
  // Board shown in the full-view modal. It must NOT clear until the exit fade completes (Slice 5)
  // — clearing it earlier relocates the live subtree back to canvas mid-fade and tears the session.
  const [fullViewId, setFullViewId] = useState<string | null>(null)
  // The modal's portal host element — the full-view BoardNode portals its live subtree into this so
  // the board is relocated (not remounted) and its session survives.
  const [fullViewHost, setFullViewHost] = useState<HTMLElement | null>(null)
  // Slice 5 motion flags. `entering`: from open until the enter tween settles. `closing`: from a
  // close request until the exit tween settles (fullViewId stays set throughout).
  const [fullViewEntering, setFullViewEntering] = useState(false)
  const [fullViewClosing, setFullViewClosing] = useState(false)
  // The native WebContentsView can't be CSS-animated and a frame scale() pollutes the rect it binds
  // to, so the full-view Browser view is HELD detached while the frame is mid-transform (enter OR
  // exit) and snaps in at settle.
  const fullViewMotion = fullViewEntering || fullViewClosing
  // Read the live full-view id inside the (stable) boardActions/Esc toggles without re-memoizing
  // them on every open/close. Synced in an effect (no ref writes in render).
  const fullViewIdRef = useRef<string | null>(fullViewId)
  useEffect(() => {
    fullViewIdRef.current = fullViewId
  }, [fullViewId])

  // Planning "full view" is a CAMERA fit (Option A), NOT the portal modal — it keeps the board in
  // the canvas under the single parent camera so toBoard/add/drag stay correct. Separate id so it
  // never collides with the portal `fullViewId`. The prior viewport is saved on enter and restored
  // on exit so leaving full view returns the user where they were.
  const [cameraFullViewId, setCameraFullViewId] = useState<string | null>(null)
  const cameraFullViewIdRef = useRef<string | null>(null)
  useEffect(() => {
    cameraFullViewIdRef.current = cameraFullViewId
  }, [cameraFullViewId])
  const priorViewportRef = useRef<Viewport | null>(null)

  // Open full view on a board: start the enter tween, mark it as the relocated board.
  const openFullView = useCallback((id: string) => {
    setFullViewClosing(false)
    setFullViewEntering(true)
    setFullViewId(id)
  }, [])
  // Request the exit tween; keep fullViewId set so the board stays relocated in the modal host
  // until the fade completes (the modal fires onExited → clears it). Idempotent.
  const closeFullView = useCallback(() => {
    if (fullViewIdRef.current) setFullViewClosing(true)
  }, [])
  // Clear full view instantly with no exit tween — for paths where the board is gone or changing
  // under it (delete / duplicate / push-preview).
  const hardCloseFullView = useCallback(() => {
    setFullViewId(null)
    setFullViewClosing(false)
    setFullViewEntering(false)
  }, [])
  const handleFullViewEntered = useCallback(() => setFullViewEntering(false), [])
  const handleFullViewExited = useCallback(() => hardCloseFullView(), [hardCloseFullView])

  // Enter camera full view on a (Planning) board: save the viewport, fit the camera to the board,
  // select it. Portal + camera full views are mutually exclusive.
  const enterCameraFullView = useCallback(
    (id: string) => {
      hardCloseFullView()
      // Only capture the user's real viewport on a fresh entry — if we're already in camera full
      // view (switching board A → board B), the ref already holds the pre-full-view position;
      // overwriting it with board A's fitted viewport would restore to A's fit instead of the
      // user's original position on exit.
      if (!cameraFullViewIdRef.current) priorViewportRef.current = rf.getViewport()
      setCameraFullViewId(id)
      selectBoard(id)
      void rf.fitView(cameraAnim({ ...FULLVIEW_OPTIONS, nodes: [{ id }] }))
    },
    [rf, selectBoard, hardCloseFullView]
  )
  // Exit camera full view: restore the saved viewport. Idempotent.
  const exitCameraFullView = useCallback(() => {
    if (!cameraFullViewIdRef.current) return
    setCameraFullViewId(null)
    const vp = priorViewportRef.current
    priorViewportRef.current = null
    if (vp) void rf.setViewport(vp, cameraAnim({}))
  }, [rf])

  return {
    fullViewId,
    fullViewHost,
    fullViewClosing,
    fullViewMotion,
    cameraFullViewId,
    setFullViewId,
    setFullViewHost,
    setCameraFullViewId,
    fullViewIdRef,
    cameraFullViewIdRef,
    openFullView,
    closeFullView,
    hardCloseFullView,
    handleFullViewEntered,
    handleFullViewExited,
    enterCameraFullView,
    exitCameraFullView
  }
}

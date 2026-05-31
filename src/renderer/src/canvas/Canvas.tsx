/**
 * The production canvas. A React Flow surface whose nodes are derived from the
 * Zustand board store (store = single source of truth); React Flow changes
 * (drag / resize / select / remove) are translated straight back into store
 * mutations. Camera follows DESIGN.md §5: drag-empty-to-pan, wheel/trackpad pan,
 * Ctrl/⌘+wheel zoom-to-cursor, zoom range 0.1–2.5, dotted grid that fades in the
 * overview band. Boards keep world-space size and degrade to an LOD card < 40%.
 *
 * Floating app chrome (project switcher, camera cluster, dock) + the empty state
 * overlay the surface (DESIGN.md §8). Double-click focuses a board (camera fit +
 * dim others); Esc clears, 1 fits, 0 resets zoom, Backspace/Delete removes.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement
} from 'react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useOnViewportChange,
  useReactFlow,
  useStore,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes
} from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore, selectLiveCount } from '../store/previewStore'
import { DEFAULT_BOARD_SIZE, MIN_BOARD_SIZE, type BoardType } from '../lib/boardSchema'
import { GRID_GAP, Z_MAX, Z_MIN, gridDotOpacity } from '../lib/canvasView'
import { cameraAnim } from '../lib/motion'
import { computeAlignment, computeResizeSnap, SNAP_THRESHOLD_PX, type Guide, type Rect } from '../lib/alignmentGuides'
import { AlignmentGuides } from './AlignmentGuides'
import { nodeChangesToIntents } from '../lib/nodeChanges'
import { BoardNode, type BoardFlowNode } from './BoardNode'
import { PreviewEdge } from './edges/PreviewEdge'
import { previewEdges } from '../lib/previewEdges'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import { resolvePreviewTarget } from '../lib/previewTarget'
import type { Board } from '../lib/boardSchema'
import { BoardActionsContext, type BoardActions } from './boardActions'
import { FullViewModal } from './FullViewModal'
import { FullViewContext } from './fullViewContext'
import { BrowserPreviewLayer } from './boards/BrowserPreviewLayer'
import { AppChrome } from './AppChrome'
import { EmptyState } from './EmptyState'
import DiagOverlay from '../spike/DiagOverlay'
import { isE2E } from '../smoke/e2eRegistry'
import { installE2EHooks } from '../smoke/e2eHooks'

const nodeTypes: NodeTypes = { board: BoardNode }
const edgeTypes: EdgeTypes = { preview: PreviewEdge }
/** Fit/reset framing (no duration — used instant for fit-on-load & initial mount;
 *  user-triggered fit/reset wrap these in `cameraAnim` for the §9 200ms tween). */
const FIT_OPTIONS = { padding: 0.2, maxZoom: 1 } as const
/** "Reset zoom" (0 / %): recenter on content pinned at 100% so it can't strand boards (#41). */
const RESET_OPTIONS = { padding: 0.2, maxZoom: 1, minZoom: 1 } as const
/** Single-board focus framing (DESIGN.md §5/§9: ~70px pad). Animated via `cameraAnim`. */
const FOCUS_OPTIONS = { padding: 0.3, maxZoom: Z_MAX } as const

/** Dot grid that fades toward the void as the camera zooms out (DESIGN.md §5). */
function FadingDots(): ReactElement {
  const zoom = useStore((s) => s.transform[2])
  return (
    <Background
      variant={BackgroundVariant.Dots}
      gap={GRID_GAP}
      size={1}
      // Mirror of the --grid-dot token (SVG fill can't read a CSS var reliably).
      color="#202022"
      style={{ opacity: gridDotOpacity(zoom) }}
    />
  )
}

function CanvasInner(): ReactElement {
  const boards = useCanvasStore((s) => s.boards)
  const selectedId = useCanvasStore((s) => s.selectedId)
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const resizeBoard = useCanvasStore((s) => s.resizeBoard)
  const removeBoard = useCanvasStore((s) => s.removeBoard)
  const selectBoard = useCanvasStore((s) => s.selectBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const duplicateBoard = useCanvasStore((s) => s.duplicateBoard)
  const projectStatus = useCanvasStore((s) => s.project.status)

  const rf = useReactFlow()
  const paneRef = useRef<HTMLDivElement>(null)
  // Live native-view count (Browser boards) for the diagnostics overlay.
  const liveViews = usePreviewStore(selectLiveCount)
  // Signal a board drag/resize to the preview layer so it detaches live native
  // views to snapshots for the duration (they'd otherwise paint over the moved board).
  const setNodeGesture = usePreviewStore((s) => s.setNodeGesture)
  // Focused board: camera is fitted to it and (dimOnFocus, fixed-on) others dim.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Board shown in the full-view modal (Task 5 feeds this to node data; Task 6 renders
  // the modal). Tracked here so the ⋯ menu's Full view can set it immediately. It must
  // NOT clear until the exit fade completes (Slice 5) — clearing it earlier relocates the
  // live subtree back to canvas mid-fade and tears the session.
  const [fullViewId, setFullViewId] = useState<string | null>(null)
  // The modal's portal host element — the full-view BoardNode portals its live subtree
  // into this so the board is relocated (not remounted) and its session survives.
  const [fullViewHost, setFullViewHost] = useState<HTMLElement | null>(null)
  // Slice 5 motion flags. `entering`: from open until the enter tween settles. `closing`:
  // from a close request until the exit tween settles (fullViewId stays set throughout).
  const [fullViewEntering, setFullViewEntering] = useState(false)
  const [fullViewClosing, setFullViewClosing] = useState(false)
  // Active alignment guide lines (ephemeral drag UI — never persisted). Set by the snap
  // pass in onNodesChange, cleared on drag stop.
  const [guides, setGuides] = useState<Guide[]>([])
  // World-space intersection rects of the snapped dragged board vs overlapped boards — drawn as
  // a render-only tint by AlignmentGuides. Set alongside guides in the snap pass, cleared on stop.
  const [overlaps, setOverlaps] = useState<Rect[]>([])
  // True while Ctrl/⌘ is held — suppresses snapping mid-drag (Figma parity). A ref so the
  // snap pass reads it without re-creating onNodesChange.
  const snapSuppressRef = useRef(false)
  // The native WebContentsView can't be CSS-animated and a frame scale() pollutes the
  // rect it binds to, so the full-view Browser view is HELD detached while the frame is
  // mid-transform (enter OR exit) and snaps in at settle.
  const fullViewMotion = fullViewEntering || fullViewClosing
  // Read the live full-view id inside the (stable) boardActions/Esc toggles without
  // re-memoizing them on every open/close. Synced in an effect (no ref writes in render).
  const fullViewIdRef = useRef<string | null>(fullViewId)
  useEffect(() => {
    fullViewIdRef.current = fullViewId
  }, [fullViewId])

  // Open full view on a board: start the enter tween, mark it as the relocated board.
  const openFullView = useCallback((id: string) => {
    setFullViewClosing(false)
    setFullViewEntering(true)
    setFullViewId(id)
  }, [])
  // Request the exit tween; keep fullViewId set so the board stays relocated in the modal
  // host until the fade completes (the modal fires onExited → clears it). Idempotent.
  const closeFullView = useCallback(() => {
    if (fullViewIdRef.current) setFullViewClosing(true)
  }, [])
  // Clear full view instantly with no exit tween — for paths where the board is gone or
  // changing under it (delete / duplicate / push-preview).
  const hardCloseFullView = useCallback(() => {
    setFullViewId(null)
    setFullViewClosing(false)
    setFullViewEntering(false)
  }, [])
  const handleFullViewEntered = useCallback(() => setFullViewEntering(false), [])
  const handleFullViewExited = useCallback(() => hardCloseFullView(), [hardCloseFullView])
  const [diag, setDiag] = useState(import.meta.env.DEV)

  // Controlled nodes: one React Flow node per board, selection + dim mirrored from
  // state. The title bar is the only drag handle (BoardFrame marks it).
  const nodes = useMemo<BoardFlowNode[]>(
    () =>
      boards.map((b) => ({
        id: b.id,
        type: 'board',
        position: { x: b.x, y: b.y },
        style: { width: b.w, height: b.h },
        data: {
          board: b,
          dimmed: focusedId !== null && focusedId !== b.id,
          fullView: fullViewId === b.id
        },
        selected: b.id === selectedId,
        dragHandle: '.board-titlebar'
      })),
    [boards, selectedId, focusedId, fullViewId]
  )

  // Preview-link arrows (Slice C′): one accent connector per Browser board linked to
  // a Terminal. Decorated here with an arrowhead; the path is computed by PreviewEdge.
  // Select the STABLE `running` record (changes ref only when a terminal's run-state
  // flips), then derive the Set in a memo. Selecting `new Set(...)` directly returns a
  // fresh reference every render → useSyncExternalStore infinite loop / React #185.
  const running = useTerminalRuntimeStore((s) => s.running)
  const runningIds = useMemo(
    () => new Set(Object.keys(running).filter((id) => running[id])),
    [running]
  )
  const edges = useMemo(
    () =>
      previewEdges(boards, runningIds).map((e) => ({
        ...e,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#4f8cff', width: 16, height: 16 }
      })),
    [boards, runningIds]
  )

  // Translate React Flow changes into store mutations. Position covers both node
  // drag and the origin shift from N/W/NW resize; dimensions (only while actively
  // resizing) covers size; select/remove mirror straight through.
  const onNodesChange = useCallback(
    (changes: NodeChange<BoardFlowNode>[]) => {
      // Smart-align pass: snap a single active board-drag onto edge/center matches and
      // surface the guide lines. Mutate change.position BEFORE translating to intents — the
      // controlled-nodes path, which avoids the xyflow #4593 setNodes-mid-drag jitter. Skip
      // while Ctrl/⌘ is held (freehand) and on multi-select drag (canonical single-node only).
      const active = changes.filter((c) => c.type === 'position' && c.dragging)
      const single = active.length === 1 ? active[0] : null
      if (single && single.type === 'position' && single.position && !snapSuppressRef.current) {
        const dragged = boards.find((b) => b.id === single.id)
        if (dragged) {
          const others = boards
            .filter((b) => b.id !== single.id)
            .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
          const rect = { x: single.position.x, y: single.position.y, w: dragged.w, h: dragged.h }
          const snap = computeAlignment(rect, others, SNAP_THRESHOLD_PX / rf.getZoom())
          single.position.x = snap.x
          single.position.y = snap.y
          setGuides(snap.guides)
          setOverlaps(snap.overlaps)
        }
      } else if (active.length > 0) {
        // Dragging but suppressed or multi-select → no guides/overlaps (no-op if already empty).
        setGuides((g) => (g.length ? [] : g))
        setOverlaps((o) => (o.length ? [] : o))
      }

      // Resize-snap pass: snap the MOVING edge(s) of a NodeResizer resize to other boards' edges/
      // centers (align line) or a 16px gutter (gap pill). Mutate the dimensions (+ N/W position)
      // change before nodeChangesToIntents, like the drag pass. Skipped while Ctrl/⌘ is held.
      const resizing = changes.find(
        (c) => c.type === 'dimensions' && c.dimensions && c.resizing
      )
      if (resizing && resizing.type === 'dimensions' && resizing.dimensions && !snapSuppressRef.current) {
        const prevBoard = boards.find((b) => b.id === resizing.id)
        if (prevBoard) {
          const posChange = changes.find(
            (c) => c.type === 'position' && c.id === resizing.id && c.position
          )
          const posP = posChange?.type === 'position' ? posChange.position : undefined
          const px = posP?.x ?? prevBoard.x
          const py = posP?.y ?? prevBoard.y
          const others = boards
            .filter((b) => b.id !== prevBoard.id)
            .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
          const prop: Rect = { x: px, y: py, w: resizing.dimensions.width, h: resizing.dimensions.height }
          const snap = computeResizeSnap(
            { x: prevBoard.x, y: prevBoard.y, w: prevBoard.w, h: prevBoard.h },
            prop,
            others,
            SNAP_THRESHOLD_PX / rf.getZoom(),
            MIN_BOARD_SIZE
          )
          resizing.dimensions.width = snap.w
          resizing.dimensions.height = snap.h
          if (posP) {
            // posP is the same object reference as posChange.position → mutating it writes back.
            posP.x = snap.x
            posP.y = snap.y
          }
          setGuides(snap.guides)
        }
      } else if (resizing) {
        // Resizing but suppressed (Ctrl/⌘ held mid-gesture) → clear guides, mirroring the drag pass.
        setGuides((g) => (g.length ? [] : g))
      } else if (changes.some((c) => c.type === 'dimensions' && c.resizing === false)) {
        // Resize settled (NodeResizer emits a final dimensions change with resizing:false) → clear.
        // Strict `=== false`: RF's initial DOM-measurement dimensions change has no `resizing` field
        // (undefined), and must not trigger guide cleanup during an unrelated drag.
        setGuides((g) => (g.length ? [] : g))
      }

      let nextSel: string | null | undefined
      for (const intent of nodeChangesToIntents(changes)) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'select') nextSel = intent.id
        else if (intent.kind === 'deselect') {
          if (nextSel === undefined) nextSel = null
        } else if (intent.kind === 'remove') {
          // #15: parking a terminal's live session BEFORE removal lets undo adopt it.
          // Sent before removeBoard → main parks before the unmount's kill arrives
          // (a single renderer's IPC is delivered in send order).
          const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
          if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
      }
      if (nextSel !== undefined) selectBoard(nextSel)
    },
    [updateBoard, resizeBoard, removeBoard, selectBoard, boards, rf]
  )

  // Add a board centered in the current view, then select it (store auto-selects).
  const addCentered = useCallback(
    (type: BoardType) => {
      const el = paneRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      const size = DEFAULT_BOARD_SIZE[type]
      useCanvasStore.getState().addBoard(type, { x: c.x - size.w / 2, y: c.y - size.h / 2 })
      // Exit focus mode so the new board (and the rest) aren't born dimmed (#14).
      setFocusedId(null)
    },
    [rf]
  )

  // Double-click = focus: fit the camera to the board and dim the others. Distinct
  // from Full view (Phase 3), which is a modal layer that doesn't move the camera.
  const focusBoard = useCallback(
    (_e: MouseEvent, node: BoardFlowNode) => {
      setFocusedId(node.id)
      selectBoard(node.id)
      // Terminal/browser content is a raster bitmap (xterm WebGL/canvas, native-view
      // snapshot) that the camera transform UPSCALES past 100% → blurry text. Cap their
      // focus zoom at 1 so a focused board lands pixel-crisp; vector boards (planning
      // notes/pen) re-rasterize sharp at any zoom and may fill the viewport (Z_MAX).
      const raster = node.data.board.type === 'terminal' || node.data.board.type === 'browser'
      const maxZoom = raster ? 1 : Z_MAX
      void rf.fitView(cameraAnim({ ...FOCUS_OPTIONS, maxZoom, nodes: [{ id: node.id }] }))
    },
    [rf, selectBoard]
  )

  // Drag start: checkpoint for undo + detach live preview views (snapshot carries
  // the motion + restores z-order so a dragged board isn't occluded). Stop: reattach.
  const onNodeDragStart = useCallback(() => {
    beginChange()
    setNodeGesture(true)
    // Pull every live native view out IMMEDIATELY (before RF starts moving the node) so a
    // dragged board can't be occluded by — or strand — an always-above native layer (#43961).
    // beginMotion still captures the snapshot; this is the synchronous safety detach (bug 10).
    void window.api.detachAllPreviews?.()
  }, [beginChange, setNodeGesture])
  const onNodeDragStop = useCallback(() => {
    setNodeGesture(false)
    setGuides((g) => (g.length ? [] : g))
    setOverlaps((o) => (o.length ? [] : o))
  }, [setNodeGesture])

  const clearSelection = useCallback(() => {
    selectBoard(null)
    setFocusedId(null)
  }, [selectBoard])

  // Board-level actions handed to every BoardNode (via context) so the shared ⋯ menu
  // / maximize button can call them per-id: Full view opens the modal layer (no camera
  // move), Duplicate clones offset 36px + selects the copy, Delete parks a terminal's
  // live session then removes the board (mirrors the React Flow delete path).
  const boardActions = useMemo<BoardActions>(
    () => ({
      // Maximize (⤢) toggles: open full view, or animate it closed if already full-view.
      requestFullView: (id) =>
        fullViewIdRef.current === id ? closeFullView() : openFullView(id),
      duplicate: (id) => {
        hardCloseFullView()
        duplicateBoard(id)
      },
      remove: (id) => {
        const removed = useCanvasStore.getState().boards.find((x) => x.id === id)
        if (removed?.type === 'terminal') void window.api.parkTerminal(id)
        if (fullViewIdRef.current === id) hardCloseFullView()
        removeBoard(id)
        setFocusedId((f) => (f === id ? null : f))
      },
      pushPreview: (fromBoardId, url) => {
        const st = useCanvasStore.getState()
        const from = st.boards.find((b) => b.id === fromBoardId)
        if (!from) return
        const target = resolvePreviewTarget(st.boards, st.selectedId, fromBoardId)
        const patch = { url, previewSourceId: fromBoardId } as Partial<Board>
        if (target.kind === 'existing') {
          // Force a (re)load even when the pushed url equals the target's current url
          // (same dev-server URL): bump the reload nonce BEFORE the store mutation so the
          // reconcile that updateBoard triggers sees it and re-navigates — otherwise the
          // url diff-skip (Bug #44) strands a load-failed view on its stale error page.
          usePreviewStore.getState().requestReload(target.id)
          st.updateBoard(target.id, patch)
          st.selectBoard(target.id)
        } else {
          const id = st.addBoard('browser', { x: from.x + from.w + 40, y: from.y })
          st.updateBoard(id, patch)
          st.selectBoard(id)
        }
        hardCloseFullView()
      }
    }),
    [duplicateBoard, removeBoard, openFullView, closeFullView, hardCloseFullView]
  )

  // Undo/redo clears store selection (canvasStore) but focus is local component
  // state — clearing it here keeps focus following selection so undo/redo can't
  // leave others dimmed with no ringed/selected board (#30 / #38, same defect).
  // Only drop focus when undo/redo actually mutates the boards — on an empty stack
  // they are true no-ops (return state unchanged) and must not silently exit focus
  // mode (#BUG-019). The boards array ref changes iff a real transition occurred.
  const doUndo = useCallback(() => {
    const before = useCanvasStore.getState().boards
    undo()
    if (useCanvasStore.getState().boards !== before) setFocusedId(null)
  }, [undo])
  const doRedo = useCallback(() => {
    const before = useCanvasStore.getState().boards
    redo()
    if (useCanvasStore.getState().boards !== before) setFocusedId(null)
  }, [redo])

  // Heal a stale focus (e.g. after undoing the focused board's creation): if the
  // focused board no longer exists, drop focus so others don't stay dimmed.
  // This is intentional derived-state synchronisation (focusedId depends on boards);
  // the eslint-disable-next-line suppresses the react-hooks/set-state-in-effect rule
  // which fires on ANY setState in an effect body, including legitimate cases like this.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setFocusedId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
    setFullViewId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [boards])

  // Keys: Esc clears, 1 fits, 0 resets zoom, Ctrl/⌘+Shift+D toggles diagnostics.
  // Backspace/Delete deletes the selected board via React Flow's deleteKeyCode.
  // Ctrl/⌘+Z → undo; Ctrl/⌘+Shift+Z → redo (guarded: no-op while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y' && !e.shiftKey && !typing) {
        e.preventDefault()
        doRedo()
        return
      }
      if (e.key === 'Escape' && !typing) {
        // Full-view Esc is handled in the capture-phase listener below (it must beat
        // xterm, which stopPropagation()s keydown so a bubble-phase listener never sees
        // Esc from a focused terminal). Here, bubble phase, only the non-full-view case.
        clearSelection()
      } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing) {
        e.preventDefault()
        setDiag((v) => !v)
      } else if (e.key === '1' && !typing) {
        void rf.fitView(cameraAnim(FIT_OPTIONS))
      } else if (e.key === '0' && !typing) {
        // Recenter content at 100% rather than zoomTo(1)-in-place, which can
        // strand every board off-screen after a far pan/zoom (#41).
        void rf.fitView(cameraAnim(RESET_OPTIONS))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf, clearSelection, doUndo, doRedo])

  // Esc ALWAYS exits full view — even when a board's own input owns focus. Must run in the
  // CAPTURE phase (window → target): xterm calls stopPropagation() on keydown, so a
  // bubble-phase listener never sees Esc from a focused full-view terminal. Capturing here
  // beats both xterm and any note editor; preventDefault + stopPropagation keep the same
  // Esc from also reaching them (the keystroke only exits full view). Browser boards can't
  // deliver keydown to the renderer at all (focused native web content) — main forwards an
  // `escape` preview event handled in BrowserPreviewLayer. No-op when not in full view.
  useEffect(() => {
    const onEscapeCapture = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && fullViewId) {
        e.preventDefault()
        e.stopPropagation()
        closeFullView()
      }
    }
    window.addEventListener('keydown', onEscapeCapture, true)
    return () => window.removeEventListener('keydown', onEscapeCapture, true)
  }, [fullViewId, closeFullView])

  // Track Ctrl/⌘ for the snap-suppress escape hatch. keydown AND keyup both read the live
  // modifier state so holding/releasing mid-drag toggles snapping without a stale latch.
  useEffect(() => {
    const update = (e: KeyboardEvent): void => {
      snapSuppressRef.current = e.ctrlKey || e.metaKey
    }
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
    }
  }, [])

  // E2E (CANVAS_SMOKE=e2e): expose the imperative test hook once the canvas (and its
  // React Flow instance) is live. No-op in every normal run (guarded by isE2E()).
  useEffect(() => {
    if (isE2E()) installE2EHooks(rf, { setFullView: setFullViewId, setFocus: setFocusedId })
  }, [rf])

  // Capture the live camera into the (untracked) store so autosave persists it.
  // onChange fires on the rAF-coalesced camera updates React Flow emits — no new
  // pump, and writing setViewport won't pollute undo history.
  useOnViewportChange({
    onChange: (vp) => setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom })
  })

  // Apply the stored camera when a project becomes `open` (restore on load/switch);
  // fall back to fitView when there's no persisted viewport (fit-on-load).
  useEffect(() => {
    if (projectStatus !== 'open') return
    const vp = useCanvasStore.getState().viewport
    if (vp) void rf.setViewport(vp)
    else void rf.fitView(FIT_OPTIONS)
    // Deps are intentionally just [projectStatus, rf]: this fires once per open
    // (status flips welcome/loading → open on each load) — viewport is read live.
  }, [projectStatus, rf])

  const fullViewBoard = fullViewId ? boards.find((b) => b.id === fullViewId) : undefined

  return (
    <BoardActionsContext.Provider value={boardActions}>
      <FullViewContext.Provider value={fullViewHost}>
        <div ref={paneRef} style={paneStyle}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onPaneClick={clearSelection}
            onNodeDoubleClick={focusBoard}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            minZoom={Z_MIN}
            maxZoom={Z_MAX}
            fitView
            fitViewOptions={FIT_OPTIONS}
            panOnScroll
            zoomActivationKeyCode={['Meta', 'Control']}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
            style={{ width: '100%', height: '100%' }}
          >
            <FadingDots />
            {/* Phase 2.2 (Browser): the store-driven PreviewManager. Mounted INSIDE
            <ReactFlow> so it can read the live camera (useReactFlow /
            useOnViewportChange) and sync every Browser board's native
            WebContentsView to the camera. Renders nothing (returns null); it owns
            the native-view lifecycle only. The Browser board is the sole board type
            allowed to touch this file. */}
            <BrowserPreviewLayer
              paneRef={paneRef}
              focusedId={focusedId}
              fullViewId={fullViewId}
              fullViewHost={fullViewHost}
              fullViewMotion={fullViewMotion}
              onRequestCloseFullView={closeFullView}
            />
          </ReactFlow>

          <AlignmentGuides guides={guides} overlaps={overlaps} />

          {boards.length === 0 && <EmptyState onAdd={addCentered} />}
          <AppChrome onAdd={addCentered} />
          {diag && <DiagOverlay liveViews={liveViews} />}
        </div>
        {fullViewBoard && (
          <FullViewModal
            closing={fullViewClosing}
            onClose={closeFullView}
            onEntered={handleFullViewEntered}
            onExited={handleFullViewExited}
            onHost={setFullViewHost}
          />
        )}
      </FullViewContext.Provider>
    </BoardActionsContext.Provider>
  )
}

export default function Canvas(): ReactElement {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}

const paneStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--void)'
}

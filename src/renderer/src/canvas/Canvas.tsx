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
import {
  DEFAULT_BOARD_SIZE,
  MIN_BOARD_SIZE,
  SCHEMA_VERSION,
  type BoardType
} from '../lib/boardSchema'
import { FIT_FRAME, GRID_GAP, Z_MAX, Z_MIN, gridDotOpacity } from '../lib/canvasView'
import { cameraAnim } from '../lib/motion'
import {
  computeAlignment,
  computeResizeSnap,
  SNAP_THRESHOLD_PX,
  type Guide,
  type Rect
} from '../lib/alignmentGuides'
import { snapOthers } from '../lib/boardGeometry'
import { AlignmentGuides } from './AlignmentGuides'
import { nodeChangesToIntents } from '../lib/nodeChanges'
import type { TileTemplate } from '../lib/tileLayout'
import { BoardNode, type BoardFlowNode } from './BoardNode'
import { buildBoardNodes, type NodeCache } from './boardNodes'
import { PreviewEdge } from './edges/PreviewEdge'
import { OrchestrationEdge } from './edges/OrchestrationEdge'
import { previewEdges } from '../lib/previewEdges'
import { orchestrationEdges } from '../lib/orchestrationEdges'
import { resolveConnectTarget } from '../lib/resolveConnectTarget'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import type { ResolvedPushTarget } from '../lib/previewTarget'
import type { Board } from '../lib/boardSchema'
import { BoardActionsContext, type BoardActions } from './boardActions'
import { FullViewModal } from './FullViewModal'
import { FullViewContext } from './fullViewContext'
import { BrowserPreviewLayer } from './boards/BrowserPreviewLayer'
import { AppChrome } from './AppChrome'
import { EmptyState } from './EmptyState'
import { DigestPanel } from './DigestPanel'
import { buildDigest } from '../lib/digest'
import DiagOverlay from '../spike/DiagOverlay'
import { isE2E } from '../smoke/e2eRegistry'
import { installE2EHooks } from '../smoke/e2eHooks'
import { useCanvasKeybindings } from './hooks/useCanvasKeybindings'
import { useTidyTile } from './hooks/useTidyTile'
import { useFullView } from './hooks/useFullView'
import { useBoardPlacement } from './hooks/useBoardPlacement'
import { TypeGlyph } from './TypeGlyph'

const nodeTypes: NodeTypes = { board: BoardNode }
const edgeTypes: EdgeTypes = { preview: PreviewEdge, orchestration: OrchestrationEdge }
// Fit/reset framing now lives in lib/canvasView (FIT_FRAME / RESET_FRAME) so the
// camera-cluster buttons in AppChrome share the exact same presets. Used instant for
// fit-on-load & initial mount; user-triggered fit/reset wrap them in `cameraAnim`.
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
  const connectors = useCanvasStore((s) => s.connectors)
  const addConnector = useCanvasStore((s) => s.addConnector)
  const removeConnector = useCanvasStore((s) => s.removeConnector)
  const projectStatus = useCanvasStore((s) => s.project.status)
  const projectDir = useCanvasStore((s) => s.project.dir)
  const viewport = useCanvasStore((s) => s.viewport)
  const tool = useCanvasStore((s) => s.tool)

  const rf = useReactFlow()
  const paneRef = useRef<HTMLDivElement>(null)
  // Live native-view count (Browser boards) for the diagnostics overlay.
  const liveViews = usePreviewStore(selectLiveCount)
  // Signal a board drag/resize to the preview layer so it detaches live native
  // views to snapshots for the duration (they'd otherwise paint over the moved board).
  const setNodeGesture = usePreviewStore((s) => s.setNodeGesture)
  // Focused board: camera is fitted to it and (dimOnFocus, fixed-on) others dim.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // M2 connector gesture (EPHEMERAL — never persisted): the source board of an in-flight
  // connector drag + the live pointer (client coords) for the rubber-band overlay; the
  // currently-selected orchestration connector (for the ✕ / Delete-key affordances).
  const [connectFromId, setConnectFromId] = useState<string | null>(null)
  const [connectPointer, setConnectPointer] = useState<{ x: number; y: number } | null>(null)
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null)
  // Live "tiled mode": the tile template currently owning the layout, or null = free placement.
  // While set, the canvas re-tiles to the window aspect on every pane resize (responsive
  // tiling). Released when the user moves/resizes a board, undoes, or picks Smart. Ephemeral
  // (never persisted) — a reopened project starts in free placement. A ref mirrors it so the
  // ResizeObserver closure reads the live value without re-subscribing.
  const [activeTile, setActiveTile] = useState<TileTemplate | null>(null)
  const activeTileRef = useRef<TileTemplate | null>(activeTile)
  useEffect(() => {
    activeTileRef.current = activeTile
  }, [activeTile])
  // Full-view state machine — portal mode (browser/terminal) + camera mode (planning), their
  // motion flags, and the open/close/enter/exit toggles — lives in useFullView (Wave-5 B5 #3).
  const {
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
  } = useFullView({ rf, selectBoard })
  // Active alignment guide lines (ephemeral drag UI — never persisted). Set by the snap
  // pass in onNodesChange, cleared on drag stop.
  const [guides, setGuides] = useState<Guide[]>([])
  // World-space intersection rects of the snapped dragged board vs overlapped boards — drawn as
  // a render-only tint by AlignmentGuides. Set alongside guides in the snap pass, cleared on stop.
  const [overlaps, setOverlaps] = useState<Rect[]>([])
  // True while Ctrl/⌘ is held — suppresses snapping mid-drag (Figma parity). A ref so the
  // snap pass reads it without re-creating onNodesChange.
  const snapSuppressRef = useRef(false)
  // The OTHER boards' rects for the active drag / resize snap pass, computed ONCE at
  // gesture-start (the non-active boards don't move during a single-board drag/resize) and
  // reused every frame instead of re-filtering + re-mapping the whole board list per frame
  // (#perf — onnodeschange-perframe-snap-allocation). Keyed by the active board id; cleared
  // when its gesture ends so the next gesture recomputes against the current layout.
  const dragOthersRef = useRef<{ id: string; rects: Rect[] } | null>(null)
  const resizeOthersRef = useRef<{ id: string; rects: Rect[] } | null>(null)
  const [digestOpen, setDigestOpen] = useState(false)
  // Auto-open the digest once per project open/switch — the React "adjust state during
  // render when a key changes" pattern (avoids setState-in-effect). Closing it stays
  // closed for that project; switching projects re-opens for the new one.
  const [digestProjectKey, setDigestProjectKey] = useState<string | null>(null)
  const openedProjectKey = projectStatus === 'open' ? (projectDir ?? 'open') : null
  if (openedProjectKey !== null && openedProjectKey !== digestProjectKey) {
    setDigestProjectKey(openedProjectKey)
    setDigestOpen(true)
  }
  const digest = useMemo(
    () => buildDigest({ schemaVersion: SCHEMA_VERSION, viewport, boards, connectors }),
    [boards, viewport, connectors]
  )

  // T-M4: cached Tier-2 prose by board id, fetched once per project open (pure disk read,
  // NO LLM call). DigestPanel renders the prose body when present, else the Tier-1 lines.
  const [prose, setProse] = useState<Record<string, string>>({})
  useEffect(() => {
    if (openedProjectKey === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProse({})
      return
    }
    let cancelled = false
    const ids = useCanvasStore.getState().boards.map((b) => b.id)
    void window.api.memory
      .readBoards(ids)
      .then((map) => {
        if (!cancelled) setProse(map)
      })
      .catch(() => {
        // The handler is written to never reject (returns {} on any guard/no-dir case);
        // this is a defensive guard so an unexpected rejection can't surface as an
        // unhandled promise. Prose stays empty → Tier-1 lines render.
      })
    return () => {
      cancelled = true
    }
    // Fire once per open/switch: openedProjectKey changes on each project-open transition.
    // boards read live (getState) so this does not re-fetch on every board edit.
  }, [openedProjectKey])

  // T-F4: manual ⟳ refresh for one card. Forces a re-summary in MAIN (budgeted + passive — no
  // new egress), then re-reads only that board's prose and merges it in. Best-effort: a no-key /
  // over-cap refresh leaves the prose unchanged (re-read returns the same / nothing). Never throws.
  const refreshBoardProse = useCallback(async (boardId: string): Promise<void> => {
    try {
      await window.api.memory.refresh(boardId)
      const map = await window.api.memory.readBoards([boardId])
      const md = map[boardId]
      if (md !== undefined) setProse((prev) => ({ ...prev, [boardId]: md }))
    } catch {
      // Both handlers are written to never reject; this guard keeps an unexpected rejection
      // from surfacing as an unhandled promise. The card simply stops its "updating…" state.
    }
  }, [])

  const [diag, setDiag] = useState(import.meta.env.DEV)

  // Controlled nodes: one React Flow node per board, selection + dim mirrored from
  // state. The title bar is the only drag handle (BoardFrame marks it). buildBoardNodes
  // REUSES each board's prior node + data object when that board's inputs are unchanged
  // (per-id cache), so moving one board re-renders only that BoardNode — not all of them
  // (#perf — nodes-memo-data-object-churn).
  // Stable per-id node cache (a lazily-created Map held in state, not a ref — so it can be
  // read in render without tripping react-hooks/refs). buildBoardNodes mutates it as a pure
  // memo cache: identical board+flag inputs return the identical node refs, so the
  // double-invoke under StrictMode stays idempotent.
  const [nodeCache] = useState<NodeCache>(() => new Map())
  const nodes = useMemo<BoardFlowNode[]>(
    () =>
      buildBoardNodes(boards, { selectedId, focusedId, fullViewId, cameraFullViewId }, nodeCache),
    [boards, selectedId, focusedId, fullViewId, cameraFullViewId, nodeCache]
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
  // Preview edges (accent) + orchestration connectors (neutral). Both derive from store
  // state via pure helpers (previewEdges / orchestrationEdges, dangling-skipped); Canvas
  // only decorates them with the marker, selection state, and the delete callback.
  const edges = useMemo(() => {
    const preview = previewEdges(boards, runningIds).map((e) => ({
      ...e,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#4f8cff', width: 16, height: 16 }
    }))
    const orchestration = orchestrationEdges(connectors, boards).map((e) => ({
      ...e,
      selected: e.id === selectedConnectorId,
      data: { onDelete: () => removeConnector(e.id) },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.id === selectedConnectorId ? '#e6e6e6' : '#5a6573',
        width: 16,
        height: 16
      }
    }))
    return [...preview, ...orchestration]
  }, [boards, runningIds, connectors, selectedConnectorId, removeConnector])

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
      // Release the cached drag-others when no single-board drag is active (drop / multi-select)
      // so the NEXT drag recomputes the others against the current layout.
      if (!single) dragOthersRef.current = null
      if (single && single.type === 'position' && single.position && !snapSuppressRef.current) {
        const dragged = boards.find((b) => b.id === single.id)
        if (dragged) {
          // Compute the other boards' rects ONCE per gesture (they don't move while one board
          // is dragged); reuse across frames instead of re-filtering + re-mapping per frame.
          if (dragOthersRef.current?.id !== single.id) {
            dragOthersRef.current = { id: single.id, rects: snapOthers(boards, single.id) }
          }
          const others = dragOthersRef.current.rects
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
      const resizing = changes.find((c) => c.type === 'dimensions' && c.dimensions && c.resizing)
      // Release the cached resize-others when no resize is active (resize end / pure drag).
      if (!resizing) resizeOthersRef.current = null
      // Manually resizing a board releases live tiled mode (no-op if already free).
      if (resizing) setActiveTile(null)
      if (
        resizing &&
        resizing.type === 'dimensions' &&
        resizing.dimensions &&
        !snapSuppressRef.current
      ) {
        const prevBoard = boards.find((b) => b.id === resizing.id)
        if (prevBoard) {
          const posChange = changes.find(
            (c) => c.type === 'position' && c.id === resizing.id && c.position
          )
          const posP = posChange?.type === 'position' ? posChange.position : undefined
          const px = posP?.x ?? prevBoard.x
          const py = posP?.y ?? prevBoard.y
          // Other boards' rects computed once per resize gesture (see the drag pass).
          if (resizeOthersRef.current?.id !== prevBoard.id) {
            resizeOthersRef.current = { id: prevBoard.id, rects: snapOthers(boards, prevBoard.id) }
          }
          const others = resizeOthersRef.current.rects
          const prop: Rect = {
            x: px,
            y: py,
            w: resizing.dimensions.width,
            h: resizing.dimensions.height
          }
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

  // Tidy / tile layout actions (paneSize · fitToBoards · applyTile · tidyAndFit + the
  // responsive-retile ResizeObserver) live in useTidyTile (Wave-5 B5 #2). Only tidyAndFit is
  // surfaced — the keymap's `t` (via useCanvasKeybindings) and AppChrome's Tidy button.
  const { tidyAndFit } = useTidyTile({ paneRef, rf, setActiveTile, setFocusedId, activeTileRef })

  // Drag-to-create placement gesture (redesign 2026-06-06): while a board type is armed via
  // the dock, a capture overlay intercepts pointer events; startPlacement begins the drag that
  // draws the ghost rect and commits addBoard on release.
  const { armed, ghost, startPlacement } = useBoardPlacement(rf)

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
    // Manually moving a board releases live tiled mode (like un-snapping a tiled window).
    setActiveTile(null)
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
    setSelectedConnectorId(null)
  }, [selectBoard])

  // Board-level actions handed to every BoardNode (via context) so the shared ⋯ menu
  // / maximize button can call them per-id: Full view opens the modal layer (no camera
  // move), Duplicate clones offset 36px + selects the copy, Delete parks a terminal's
  // live session then removes the board (mirrors the React Flow delete path).
  const boardActions = useMemo<BoardActions>(() => {
    // Apply a resolved push target: re-point an existing browser (forcing a reload) or
    // spawn a fresh one beside the source terminal. Shared by the auto path (pushPreview)
    // and the explicit multi-browser picker (pushPreviewTo).
    const applyPush = (
      st: ReturnType<typeof useCanvasStore.getState>,
      from: Board,
      url: string,
      target: ResolvedPushTarget
    ): void => {
      const patch = { url, previewSourceId: from.id } as Partial<Board>
      if (target.kind === 'existing') {
        // Force a (re)load even when the pushed url equals the target's current url
        // (same dev-server URL): bump the reload nonce BEFORE the store mutation so the
        // reconcile that updateBoard triggers sees it and re-navigates — otherwise the
        // url diff-skip (Bug #44) strands a load-failed view on its stale error page.
        usePreviewStore.getState().requestReload(target.id)
        st.updateBoard(target.id, patch)
        st.selectBoard(target.id)
      } else {
        // Exit focus so the freshly spawned browser isn't born dimmed (STATE-1).
        setFocusedId(null)
        const id = st.addBoard('browser', { x: from.x + from.w + 40, y: from.y })
        st.updateBoard(id, patch)
        st.selectBoard(id)
      }
      hardCloseFullView()
    }

    return {
      // Maximize (⤢) toggles full view. Planning uses a CAMERA fit (Option A — keeps the
      // board in the canvas under one transform so add/drag stay correct); Browser/Terminal
      // use the portal modal (they need it to keep live native content alive).
      requestFullView: (id) => {
        const type = useCanvasStore.getState().boards.find((b) => b.id === id)?.type
        if (type === 'planning') {
          if (cameraFullViewIdRef.current === id) exitCameraFullView()
          else enterCameraFullView(id)
        } else if (fullViewIdRef.current === id) {
          closeFullView()
        } else {
          openFullView(id)
        }
      },
      duplicate: (id) => {
        hardCloseFullView()
        if (cameraFullViewIdRef.current === id) exitCameraFullView()
        // Exit focus so the clone isn't born dimmed (mirrors addCentered, #14 / STATE-1).
        setFocusedId(null)
        duplicateBoard(id)
      },
      remove: (id) => {
        const removed = useCanvasStore.getState().boards.find((x) => x.id === id)
        if (removed?.type === 'terminal') void window.api.parkTerminal(id)
        if (fullViewIdRef.current === id) hardCloseFullView()
        if (cameraFullViewIdRef.current === id) exitCameraFullView()
        removeBoard(id)
        setFocusedId((f) => (f === id ? null : f))
      },
      pushPreviewTo: (fromBoardId, url, target) => {
        const st = useCanvasStore.getState()
        const from = st.boards.find((b) => b.id === fromBoardId)
        if (!from) return
        applyPush(st, from, url, target)
      },
      // M2: begin a connector drag — arm the ephemeral gesture; the window pointer
      // listeners (effect below) track the rubber-band + resolve the drop target on release.
      startConnect: (fromBoardId) => {
        setSelectedConnectorId(null)
        setConnectPointer(null)
        setConnectFromId(fromBoardId)
      }
    }
  }, [
    duplicateBoard,
    removeBoard,
    openFullView,
    closeFullView,
    hardCloseFullView,
    enterCameraFullView,
    exitCameraFullView,
    fullViewIdRef,
    cameraFullViewIdRef
  ])

  // Undo/redo clears store selection (canvasStore) but focus is local component
  // state — clearing it here keeps focus following selection so undo/redo can't
  // leave others dimmed with no ringed/selected board (#30 / #38, same defect).
  // Only drop focus when undo/redo actually mutates the boards — on an empty stack
  // they are true no-ops (return state unchanged) and must not silently exit focus
  // mode (#BUG-019). The boards array ref changes iff a real transition occurred.
  const doUndo = useCallback(() => {
    const before = useCanvasStore.getState().boards
    undo()
    if (useCanvasStore.getState().boards !== before) {
      setFocusedId(null)
      setActiveTile(null) // restored geometry must not be reflowed away on the next resize
    }
  }, [undo])
  const doRedo = useCallback(() => {
    const before = useCanvasStore.getState().boards
    redo()
    if (useCanvasStore.getState().boards !== before) {
      setFocusedId(null)
      setActiveTile(null)
    }
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
    setCameraFullViewId((c) => (c !== null && !boards.some((b) => b.id === c) ? null : c))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [boards, setFullViewId, setCameraFullViewId])

  // M2 connector drag: while a source board is armed (title-bar connector handle pressed),
  // track the pointer for the rubber-band and, on release, resolve the drop target from
  // STORE GEOMETRY (pure resolveConnectTarget — no DOM hit-test) → add an orchestration
  // connector. Window-level so the drag still resolves when released past the board edge.
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
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [connectFromId, rf, addConnector])

  // Canvas keyboard bindings (Wave-5 B5): selected-connector Delete/Backspace · the main keymap
  // (undo/redo · Esc-clear · diag toggle · 1 fit / 0 reset · t tidy) · the capture-phase
  // Esc-always-exits-full-view · Ctrl/⌘ snap-suppress tracking — all in useCanvasKeybindings.
  useCanvasKeybindings({
    rf,
    clearSelection,
    doUndo,
    doRedo,
    tidyAndFit,
    setDiag,
    selectedConnectorId,
    removeConnector,
    setSelectedConnectorId,
    fullViewId,
    cameraFullViewId,
    closeFullView,
    exitCameraFullView,
    snapSuppressRef
  })

  // E2E (CANVAS_E2E): expose the imperative test hook once the canvas (and its
  // React Flow instance) is live. No-op in every normal run (guarded by isE2E()).
  useEffect(() => {
    if (isE2E())
      installE2EHooks(rf, {
        setFullView: setFullViewId,
        openFullViewAnimated: openFullView,
        closeFullViewAnimated: closeFullView,
        setFocus: setFocusedId,
        setDigestOpen,
        enterCameraFullView,
        exitCameraFullView,
        selectConnector: setSelectedConnectorId
      })
  }, [
    rf,
    openFullView,
    closeFullView,
    setDigestOpen,
    enterCameraFullView,
    exitCameraFullView,
    setFullViewId,
    setCameraFullViewId
  ])

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
    // a freshly opened project starts in free placement (tiled mode is ephemeral). Intentional
    // derived-state reset on the open transition — the rule fires on ANY setState in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTile(null)
    const vp = useCanvasStore.getState().viewport
    if (vp) void rf.setViewport(vp)
    else void rf.fitView(FIT_FRAME)
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
            onPaneClick={() => {
              clearSelection()
              exitCameraFullView()
            }}
            onEdgeClick={(_, edge) => {
              // Select an orchestration connector for delete (✕ / Delete-key). Clear the
              // board selection so RF's deleteKeyCode can't also delete a board.
              if (edge.type !== 'orchestration') return
              selectBoard(null)
              setFocusedId(null)
              setSelectedConnectorId(edge.id)
            }}
            onNodeDoubleClick={focusBoard}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            minZoom={Z_MIN}
            maxZoom={Z_MAX}
            fitView
            fitViewOptions={FIT_FRAME}
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

          {/* Drag-to-create (redesign 2026-06-06): while a dock button is armed, a transparent
              overlay owns the pointer — boards go non-interactive and React Flow can't pan, so a
              press→drag draws a new board. The ghost is a screen-space rect; world conversion +
              addBoard happen on release (useBoardPlacement). Chrome (z-50) stays above this (z-40),
              so the Select button / dock buttons remain clickable to re-arm or cancel. */}
          {armed && (
            <div className="placement-capture" onPointerDown={startPlacement}>
              {ghost && (
                <div
                  className="placement-ghost"
                  style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}
                >
                  <span className="placement-ghost-chip">
                    <TypeGlyph type={tool as BoardType} /> {tool}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* M2 connector rubber-band: a calm dashed line from the source board's center to
              the live pointer while a connector drag is in flight (ephemeral — drawn only,
              the actual link is resolved on release). Positioned `fixed` so it shares the
              client-coordinate space of both the pointer and flowToScreenPosition (no pane
              rect / ref read in render); pointer-events off. */}
          {connectFromId &&
            connectPointer &&
            (() => {
              const src = boards.find((b) => b.id === connectFromId)
              if (!src) return null
              const c = rf.flowToScreenPosition({ x: src.x + src.w / 2, y: src.y + src.h / 2 })
              return (
                <svg
                  style={{
                    position: 'fixed',
                    inset: 0,
                    width: '100vw',
                    height: '100vh',
                    pointerEvents: 'none',
                    zIndex: 50
                  }}
                >
                  <line
                    x1={c.x}
                    y1={c.y}
                    x2={connectPointer.x}
                    y2={connectPointer.y}
                    stroke="var(--border-strong)"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                  />
                </svg>
              )
            })()}

          {boards.length === 0 && <EmptyState onAdd={addCentered} />}
          <AppChrome onTidy={tidyAndFit} />
          <DigestPanel
            digest={digest}
            prose={prose}
            onRefresh={refreshBoardProse}
            open={digestOpen}
            onOpen={() => setDigestOpen(true)}
            onClose={() => setDigestOpen(false)}
          />
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

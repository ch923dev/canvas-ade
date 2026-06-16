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
  useReactFlow,
  useStore,
  useStoreApi,
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
import {
  computeAlignment,
  computeResizeSnap,
  SNAP_THRESHOLD_PX,
  type Guide,
  type Rect
} from '../lib/alignmentGuides'
import { snapOthers } from '../lib/boardGeometry'
import { AlignmentGuides } from './AlignmentGuides'
import { nodeChangesToIntents, foldSelectionIntents } from '../lib/nodeChanges'
import type { TileTemplate } from '../lib/tileLayout'
import { BoardNode, type BoardFlowNode } from './BoardNode'
import { buildBoardNodes, type NodeCache } from './boardNodes'
import { PreviewEdge } from './edges/PreviewEdge'
import { OrchestrationEdge } from './edges/OrchestrationEdge'
import { previewEdges } from '../lib/previewEdges'
import { orchestrationEdges } from '../lib/orchestrationEdges'
import { planNodeRemovalCleanup } from '../lib/canvasDecisions'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import { BoardActionsContext } from './boardActions'
import { FullViewModal } from './FullViewModal'
import { FullViewContext } from './fullViewContext'
import { BrowserPreviewLayer } from './boards/BrowserPreviewLayer'
import { BackdropLayer } from './backdrop/BackdropLayer'
import { GroupBoxLayer } from './GroupBoxLayer'
import { GroupNamePopover } from './GroupNamePopover'
import { GroupFocusPicker } from './GroupFocusPicker'
import { GroupContextMenu } from './GroupContextMenu'
import { AppChrome } from './AppChrome'
import { EmptyState } from './EmptyState'
import { DigestPanel } from './DigestPanel'
import { buildDigest } from '../lib/digest'
import DiagOverlay from '../spike/DiagOverlay'
import { isE2E } from '../smoke/e2eRegistry'
import { installE2EHooks } from '../smoke/e2eHooks'
import { useCanvasKeybindings } from './hooks/useCanvasKeybindings'
import { useBoardKeyboardNav } from './hooks/useBoardKeyboardNav'
import { useBoardActions } from './hooks/useBoardActions'
import { CommandPalette } from './palette/CommandPalette'
import { usePaletteController } from './palette/usePaletteController'
import { useTidyTile } from './hooks/useTidyTile'
import { useFullView } from './hooks/useFullView'
import { useBoardPlacement, useConnectorDrag } from './hooks/useBoardPlacement'
import { useGroupInteractions } from './hooks/useGroupInteractions'
import { useZoomSettle } from './hooks/useZoomSettle'
import { PlacementCaptureOverlay } from './PlacementCaptureOverlay'
import { MinimapIsland } from './wayfinding/MinimapIsland'
import { useWayfindingStore } from '../store/wayfindingStore'

const nodeTypes: NodeTypes = { board: BoardNode }
const edgeTypes: EdgeTypes = { preview: PreviewEdge, orchestration: OrchestrationEdge }
// Fit/reset framing now lives in lib/canvasView (FIT_FRAME / RESET_FRAME) so the
// camera-cluster buttons in AppChrome share the exact same presets. Used instant for
// fit-on-load & initial mount; user-triggered fit/reset wrap them in `cameraAnim`.
// Single-board focus framing moved to useBoardKeyboardNav (D4-B): Enter and
// double-click share its focusBoardById, so the two paths can never drift.

/** Lattice grid that fades toward the void as the camera zooms out (DESIGN.md §5).
 *  With a backdrop active the grid is opt-in via the picker (spec §3 — background.gridDots)
 *  and its style is the picker's lattice pick (PR 4 — background.gridStyle: dots/lines/cross,
 *  RF-native variants); backdrop-less ("none"/null) keeps today's always-on dot grid. */
function FadingDots(): ReactElement | null {
  const zoom = useStore((s) => s.transform[2])
  const background = useCanvasStore((s) => s.background)
  if (background !== null && background.kind !== 'none' && !background.gridDots) return null
  // GridStyle values are exactly the BackgroundVariant string members ('dots'/'lines'/'cross').
  const variant = (background?.gridStyle ?? 'dots') as BackgroundVariant
  return (
    <Background
      variant={variant}
      gap={GRID_GAP}
      // RF size = dot radius (1) / cross arm length (6, its default); ignored for lines.
      size={variant === BackgroundVariant.Cross ? 6 : 1}
      // Mirror of the --grid-dot token (SVG fill can't read a CSS var reliably).
      color="#202022"
      style={{ opacity: gridDotOpacity(zoom) }}
    />
  )
}

// Group-create chord glyph: ⌘G on macOS, Ctrl+G elsewhere (the keybinding fires on either
// Ctrl or ⌘). Mirrors TerminalBoard's IS_MAC detection so the FAB label matches the real key.
const IS_MAC = navigator.platform.toLowerCase().includes('mac')

function CanvasInner(): ReactElement {
  const boards = useCanvasStore((s) => s.boards)
  // Boolean-projected so camera frames / unrelated writes never re-render on it.
  const backdropActive = useCanvasStore(
    (s) => s.background !== null && s.background.kind !== 'none'
  )
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const resizeBoard = useCanvasStore((s) => s.resizeBoard)
  const removeBoard = useCanvasStore((s) => s.removeBoard)
  const selectBoard = useCanvasStore((s) => s.selectBoard)
  const setSelection = useCanvasStore((s) => s.setSelection)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const duplicateBoard = useCanvasStore((s) => s.duplicateBoard)
  const connectors = useCanvasStore((s) => s.connectors)
  const addConnector = useCanvasStore((s) => s.addConnector)
  const removeConnector = useCanvasStore((s) => s.removeConnector)
  // groupSelection mints groups via useCanvasStore.getState().addGroup (it reads selectedIds +
  // groups off the live snapshot in the same call), so only renameGroup needs a reactive binding.
  const renameGroup = useCanvasStore((s) => s.renameGroup)
  const removeGroup = useCanvasStore((s) => s.removeGroup)
  const removeBoardFromAllGroups = useCanvasStore((s) => s.removeBoardFromAllGroups)
  // Reactive groups read for the focus picker (it lists one row per group; needs to re-render
  // when groups change). The fit/select helpers read off getState() so they don't depend on it.
  const groups = useCanvasStore((s) => s.groups)
  const projectStatus = useCanvasStore((s) => s.project.status)
  const projectDir = useCanvasStore((s) => s.project.dir)
  const viewport = useCanvasStore((s) => s.viewport)

  const rf = useReactFlow()
  const paneRef = useRef<HTMLDivElement>(null)
  // Live native-view count (Browser boards) for the diagnostics overlay.
  const liveViews = usePreviewStore(selectLiveCount)
  // Signal a board drag/resize to the preview layer so it detaches live native
  // views to snapshots for the duration (they'd otherwise paint over the moved board).
  const setNodeGesture = usePreviewStore((s) => s.setNodeGesture)
  // Focused board: camera is fitted to it and (dimOnFocus, fixed-on) others dim.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Group interaction choreography (naming popover · focus picker · tab context menu · S6 absorb
  // reflow flag + drag-onto-box drop target + timer · group action callbacks) lives in
  // useGroupInteractions (god-file maintainability, Tier-1). All names destructured back into
  // scope so every JSX/boardActions/keybinding/e2e use-site stays byte-identical.
  const {
    namingGroupId,
    namePopAt,
    pickerAt,
    groupMenu,
    reflowing,
    dropTargetGroupId,
    setNamingGroupId,
    setNamePopAt,
    setPickerAt,
    setGroupMenu,
    setDropTargetGroupId,
    groupSelection,
    fitGroup,
    selectGroupMembers,
    focusGroup,
    reflowAddToGroup,
    disarmReflow,
    onNodeDragGroupHitTest
  } = useGroupInteractions({ rf, paneRef, setFocusedId })
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
  // The board id of the in-flight node drag (null = no drag). #BUG-011: if that board is
  // removed mid-drag (Delete key / MCP), @xyflow's XYDrag ABORTS the gesture without calling
  // onNodeDragStop — the healing effect below uses this ref to do the stop handler's cleanup.
  const dragNodeIdRef = useRef<string | null>(null)
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
      buildBoardNodes(boards, { selectedIds, focusedId, fullViewId, cameraFullViewId }, nodeCache),
    [boards, selectedIds, focusedId, fullViewId, cameraFullViewId, nodeCache]
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
    // Marker colors are CSS vars (D0-3): React Flow passes the color into the marker
    // polyline's inline style and quotes the marker-id url, so var() resolves cleanly.
    const preview = previewEdges(boards, runningIds).map((e) => ({
      ...e,
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)', width: 16, height: 16 }
    }))
    const orchestration = orchestrationEdges(connectors, boards).map((e) => ({
      ...e,
      selected: e.id === selectedConnectorId,
      data: { onDelete: () => removeConnector(e.id) },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.id === selectedConnectorId ? 'var(--connector-selected)' : 'var(--connector)',
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

      // Apply each change's SIDE EFFECTS (move/resize/remove); the multi-selection is folded
      // after the loop by the pure foldSelectionIntents (nodeChanges.ts, unit-tested) so the
      // select/deselect/ghost-id-prune rules live in one place. Snapshot selectedIds BEFORE the
      // loop — removeBoard sweeps it mid-loop, but the fold result below is authoritative.
      const intents = nodeChangesToIntents(changes)
      const selBefore = useCanvasStore.getState().selectedIds
      for (const intent of intents) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'remove') {
          // #15: park a terminal's live session BEFORE removal so undo can adopt it. RF's
          // deleteKeyCode removes EVERY selected node, so this loops over the whole selection.
          const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
          // #BUG-015: swallow the invoke rejection (teardown/channel-gone race on a closing
          // window) so it can't surface as an unhandled promise — mirrors the memory.* guards above.
          if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id).catch(() => {})
          // #BUG-012: keyboard-delete (deleteKeyCode) reaches removal HERE, bypassing
          // boardActions.remove — so tear down any full-view mode pointing at this board
          // FIRST (same guards boardActions.remove uses). Otherwise fullViewId/cameraFullViewId
          // transiently dangle at a gone board for one render, and applyLiveness needlessly
          // demotes every other Browser board to a snapshot until the healing effect heals it.
          for (const step of planNodeRemovalCleanup(
            intent.id,
            fullViewIdRef.current,
            cameraFullViewIdRef.current
          )) {
            if (step === 'closeFullView') hardCloseFullView()
            else exitCameraFullView()
          }
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
        // select/deselect carry no side effect — folded below (ghost-id prune included).
      }
      const folded = foldSelectionIntents(selBefore, intents)
      if (folded.changed) {
        setSelection(folded.ids)
        // #BUG-010: selecting a board must clear a selected connector (mutual exclusivity —
        // the inverse of onEdgeClick's selectBoard(null)). Otherwise one Delete fires BOTH
        // the connector keybinding AND RF's deleteKeyCode (its useKeyPress ignores
        // defaultPrevented), silently removing the connector and the board together.
        if (folded.ids.length > 0) setSelectedConnectorId(null)
      }
    },
    // Merged deps: the multi-select fold uses setSelection (groups branch); the keyboard-delete
    // path uses the full-view cleanup refs/closers (#BUG-012, #85). selectBoard is no longer
    // referenced here (setSelection drives selection).
    [
      updateBoard,
      resizeBoard,
      removeBoard,
      setSelection,
      boards,
      rf,
      fullViewIdRef,
      cameraFullViewIdRef,
      hardCloseFullView,
      exitCameraFullView
    ]
  )

  // Add a board centered in the current view, then select it (store auto-selects).
  const addCentered = useCallback(
    (type: BoardType) => {
      const el = paneRef.current
      if (!el) return
      // (The Command board is a singleton — `addBoard` selects the existing one instead of
      // minting a second, so every add path stays single-orchestrator without special-casing here.)
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

  // Drag/place capture overlay state (redesign 2026-06-06; command place-to-create 2026-06-16):
  // drag tools rubber-band, the Command board follows-and-clicks. Forwarded to the overlay below.
  const placement = useBoardPlacement(rf)

  // D4-B keyboard-first board nav: Tab cycle · arrow move / Alt+arrow resize (one undo
  // step per burst) · Enter focus. focusBoardById is the SAME camera-fit + dim path the
  // double-click gesture uses (onNodeDoubleClick delegates below). Handlers dispatch via
  // useCanvasKeybindings (resolver-driven, drift-guarded against the ? sheet).
  const {
    cycleBoard,
    moveSelectedBoards,
    resizeSelectedBoards,
    focusSelectedBoard,
    focusBoardById
  } = useBoardKeyboardNav({ rf, paneRef, setFocusedId })

  // Double-click = focus: fit the camera to the board and dim the others. Distinct
  // from Full view (Phase 3), which is a modal layer that doesn't move the camera.
  const focusBoard = useCallback(
    (_e: MouseEvent, node: BoardFlowNode) => focusBoardById(node.id),
    [focusBoardById]
  )

  // Drag start: checkpoint for undo + detach live preview views (snapshot carries
  // the motion + restores z-order so a dragged board isn't occluded). Stop: reattach.
  const onNodeDragStart = useCallback(
    (_e: MouseEvent, node: BoardFlowNode) => {
      dragNodeIdRef.current = node.id
      beginChange()
      setNodeGesture(true)
      // Disarm any in-flight reflow: if a drag starts inside the ~340ms absorb window the dragged
      // node would otherwise inherit `.reflowing .react-flow__node`'s transform transition and trail
      // the cursor. Clear the timer + class so the drag is direct.
      disarmReflow()
      // Manually moving a board releases live tiled mode (like un-snapping a tiled window).
      setActiveTile(null)
      // Pull every live native view out IMMEDIATELY (before RF starts moving the node) so a
      // dragged board can't be occluded by — or strand — an always-above native layer (#43961).
      // beginMotion still captures the snapshot; this is the synchronous safety detach (bug 10).
      void window.api.detachAllPreviews?.()
    },
    [beginChange, setNodeGesture, disarmReflow]
  )
  // S6 drag-onto-box: hit-test the dragged board's center against group boxes (lights the hovered
  // box as a drop target) — logic lives in useGroupInteractions.
  const onNodeDrag = useCallback(
    (_e: MouseEvent, node: BoardFlowNode) => onNodeDragGroupHitTest(node),
    [onNodeDragGroupHitTest]
  )

  const onNodeDragStop = useCallback(
    (_e: MouseEvent, node: BoardFlowNode) => {
      dragNodeIdRef.current = null
      setNodeGesture(false)
      setGuides((g) => (g.length ? [] : g))
      setOverlaps((o) => (o.length ? [] : o))
      const target = dropTargetGroupId
      setDropTargetGroupId(null)
      // Dropped a non-member board inside a group box → absorb it (membership + re-pack).
      if (target && node) reflowAddToGroup(target, [node.id])
    },
    [setNodeGesture, dropTargetGroupId, reflowAddToGroup, setDropTargetGroupId]
  )

  const clearSelection = useCallback(() => {
    selectBoard(null)
    setFocusedId(null)
    setSelectedConnectorId(null)
  }, [selectBoard])

  // Board-level actions handed to every BoardNode (via context) — full view /
  // duplicate / delete / push-preview / connect / group ops. Extracted verbatim to
  // useBoardActions (D4-A ratchet payment); the command palette routes its
  // selected-board verbs through the same object.
  const boardActions = useBoardActions({
    duplicateBoard,
    removeBoard,
    openFullView,
    closeFullView,
    hardCloseFullView,
    enterCameraFullView,
    exitCameraFullView,
    fullViewIdRef,
    cameraFullViewIdRef,
    reflowAddToGroup,
    removeBoardFromAllGroups,
    setFocusedId,
    setSelectedConnectorId,
    setConnectPointer,
    setConnectFromId
  })

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
    // #BUG-011: the dragged board was removed mid-drag (Delete key / MCP) — XYDrag aborts
    // the gesture WITHOUT calling onNodeDragStop, so do its cleanup here. Otherwise
    // nodeGesture latches true (every Browser preview frozen as a snapshot) and the last
    // snap frame's guides / overlap tints / lit drop-target box stay painted.
    if (dragNodeIdRef.current !== null && !boards.some((b) => b.id === dragNodeIdRef.current)) {
      dragNodeIdRef.current = null
      setNodeGesture(false)
      setGuides((g) => (g.length ? [] : g))
      setOverlaps((o) => (o.length ? [] : o))
      setDropTargetGroupId(null)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [boards, setFullViewId, setCameraFullViewId, setNodeGesture, setDropTargetGroupId])

  // M2 connector drag: while a source board is armed (title-bar connector handle pressed),
  // track the pointer for the rubber-band and, on release, resolve the drop target from
  // store geometry → add an orchestration connector. Lives in useConnectorDrag (the
  // placement gesture's sibling hook) with the #BUG-048 Esc/blur/pointercancel abort.
  useConnectorDrag({ rf, connectFromId, setConnectFromId, setConnectPointer, addConnector })

  // D4-A command palette: open/close state + the verb adapters, owned by the
  // controller hook so Canvas stays thin (779-pin). Ctrl+K / `?` route here via
  // useCanvasKeybindings' openPalette dep.
  const { paletteView, openPalette, closePalette, paletteVerbs } = usePaletteController({
    rf,
    boardActions,
    addCentered,
    selectBoard,
    setFocusedId,
    groupSelection,
    fitGroup,
    selectGroupMembers,
    removeGroup,
    tidyAndFit,
    doUndo,
    doRedo
  })

  // Canvas keyboard bindings (Wave-5 B5): selected-connector Delete/Backspace · the main keymap
  // (undo/redo · Esc-clear · diag toggle · 1 fit / 0 reset · t tidy · Ctrl/⌘+K palette /
  // ? shortcuts) · the capture-phase Esc-always-exits-full-view · Ctrl/⌘ snap-suppress
  // tracking — all in useCanvasKeybindings.
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
    snapSuppressRef,
    groupSelection,
    focusGroup,
    openPalette,
    // D4-C: bare `m` toggles the wayfinding minimap (zustand action — identity-stable).
    toggleMinimap: useWayfindingStore((s) => s.toggleMinimap),
    cycleBoard,
    moveSelectedBoards,
    resizeSelectedBoards,
    focusSelectedBoard
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
        selectConnector: setSelectedConnectorId,
        closeGroupNaming: () => {
          setNamingGroupId(null)
          setNamePopAt(null)
        },
        closeGroupPicker: () => setPickerAt(null),
        closeGroupMenu: () => setGroupMenu(null),
        addToGroupReflowed: (gid, bid) => reflowAddToGroup(gid, [bid])
      })
  }, [
    rf,
    openFullView,
    closeFullView,
    setDigestOpen,
    enterCameraFullView,
    exitCameraFullView,
    setFullViewId,
    setCameraFullViewId,
    reflowAddToGroup,
    setGroupMenu,
    setNamePopAt,
    setNamingGroupId,
    setPickerAt
  ])

  // Capture the live camera into the (untracked) store so autosave persists it.
  // NOT useOnViewportChange: that is a SINGLE-SLOT store field (last writer wins), and
  // usePreviewManager owns it for the native Browser-preview camera sync (onStart/onChange/
  // onEnd). A second useOnViewportChange here (Canvas is the parent → its effect commits
  // last) clobbered the preview's onStart/onEnd with undefined and froze every Browser
  // board's WebContentsView on pan/zoom. The RF store `transform` subscription is additive
  // (any number of subscribers) and fires at the same rAF-coalesced cadence; setViewport is
  // untracked (no undo) and L2-guards equal values (no autosave spam).
  // See docs/research/2026-06-06-browser-preview-camera-sync-rootcause.md.
  const storeApi = useStoreApi()
  useEffect(() => {
    let prev: readonly [number, number, number] | null = null
    return storeApi.subscribe((s) => {
      const t = s.transform
      if (prev && t[0] === prev[0] && t[1] === prev[1] && t[2] === prev[2]) return
      prev = t
      setViewport({ x: t[0], y: t[1], zoom: t[2] })
    })
  }, [storeApi, setViewport])

  // Settle watcher riding the mirror above: snaps a settled zoom near 100% to exactly
  // 1 + publishes settled zoom for the terminal WebGL policy (useZoomSettle docs).
  useZoomSettle()

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
        <div
          ref={paneRef}
          className={reflowing ? 'reflowing' : undefined}
          style={paneStyle}
          data-backdrop={backdropActive ? '' : undefined}
        >
          {/* Screen-fixed wallpaper layer (docs/canvas-backdrop). Sibling BEFORE
              <ReactFlow> ⇒ paints beneath it; [data-backdrop] turns the RF surface
              transparent so the layer shows through ("none" stays pixel-identical). */}
          <BackdropLayer />
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
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            minZoom={Z_MIN}
            maxZoom={Z_MAX}
            fitView
            fitViewOptions={FIT_FRAME}
            panOnScroll
            zoomActivationKeyCode={['Meta', 'Control']}
            deleteKeyCode={['Backspace', 'Delete']}
            // D4-B: React Flow's built-in node keyboard a11y is replaced by the
            // useBoardKeyboardNav model. The built-in put tabIndex=0 on every node (Tab
            // walked raw DOM order, not the canvas) and its node-level arrow-move
            // committed position changes with NO undo checkpoint — every keyboard move
            // silently merged into the previous undo step. deleteKeyCode is unaffected.
            disableKeyboardA11y
            proOptions={{ hideAttribution: true }}
            style={{ width: '100%', height: '100%' }}
          >
            <FadingDots />
            <GroupBoxLayer
              dropTargetId={dropTargetGroupId}
              onTabClick={selectGroupMembers}
              onTabDoubleClick={fitGroup}
              onTabContextMenu={(id, at) => setGroupMenu({ id, at })}
            />
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
              digestOpen={digestOpen}
            />
            {/* D4-C wayfinding minimap (§8 bottom-right island, toggled via `m`/palette).
            Inside <ReactFlow> — RF's <MiniMap> reads nodes + viewport from the RF store.
            Board click = the SAME focus path as Enter/double-click (focusBoardById). */}
            <MinimapIsland onJumpToBoard={focusBoardById} />
          </ReactFlow>

          <AlignmentGuides guides={guides} overlaps={overlaps} />

          {/* Drag/place capture overlay (extracted — file-size doctrine). Mounts only while armed;
              see PlacementCaptureOverlay / useBoardPlacement. */}
          <PlacementCaptureOverlay {...placement} />

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
          {selectedIds.length >= 2 && (
            <button
              className="group-fab"
              onClick={groupSelection}
              title="Group selection (Ctrl+G)"
              aria-label={`Group ${selectedIds.length} selected boards`}
            >
              <span style={{ fontFamily: 'var(--mono)' }}>{IS_MAC ? '⌘G' : 'Ctrl+G'}</span> Group{' '}
              {selectedIds.length}
            </button>
          )}
          {namingGroupId && namePopAt && (
            <GroupNamePopover
              initial={
                useCanvasStore.getState().groups.find((g) => g.id === namingGroupId)?.name ?? ''
              }
              at={namePopAt}
              onCommit={(name) => {
                // Only rename if the group still exists: if it was undone away while the popover
                // was open, namingGroupId is stale — renameGroup would no-op, so guard explicitly
                // rather than rely on that (and don't resurrect a removed group's name).
                if (useCanvasStore.getState().groups.some((g) => g.id === namingGroupId)) {
                  renameGroup(namingGroupId, name)
                }
                setNamingGroupId(null)
                setNamePopAt(null)
              }}
              onCancel={() => {
                setNamingGroupId(null)
                setNamePopAt(null)
              }}
            />
          )}
          {pickerAt && (
            <GroupFocusPicker
              groups={groups}
              at={pickerAt}
              onPick={(id) => {
                setPickerAt(null)
                fitGroup(id)
              }}
              onClose={() => setPickerAt(null)}
            />
          )}
          {groupMenu && (
            <GroupContextMenu
              at={groupMenu.at}
              hasSelection={selectedIds.length > 0}
              onRename={() => {
                const g = useCanvasStore.getState().groups.find((x) => x.id === groupMenu.id)
                if (g) {
                  setNamePopAt(groupMenu.at)
                  setNamingGroupId(groupMenu.id)
                }
                setGroupMenu(null)
              }}
              onFocus={() => {
                fitGroup(groupMenu.id)
                setGroupMenu(null)
              }}
              onAddSelected={() => {
                // Animate the absorb re-pack, same as the drag-onto-box and board ⋯-menu paths —
                // all three add-to-group routes converge on reflowAddToGroup for consistent feedback.
                reflowAddToGroup(groupMenu.id, useCanvasStore.getState().selectedIds)
                setGroupMenu(null)
              }}
              onRemove={() => {
                removeGroup(groupMenu.id)
                setGroupMenu(null)
              }}
              onClose={() => setGroupMenu(null)}
            />
          )}
          <AppChrome onTidy={tidyAndFit} onFocusGroup={focusGroup} />
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
        {paletteView && (
          <CommandPalette initialView={paletteView} verbs={paletteVerbs} onClose={closePalette} />
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

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
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type NodeChange,
  type NodeTypes
} from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore, selectLiveCount } from '../store/previewStore'
import { DEFAULT_BOARD_SIZE, type BoardType } from '../lib/boardSchema'
import { GRID_GAP, Z_MAX, Z_MIN, gridDotOpacity } from '../lib/canvasView'
import { nodeChangesToIntents } from '../lib/nodeChanges'
import { BoardNode, type BoardFlowNode } from './BoardNode'
import { BrowserPreviewLayer } from './boards/BrowserPreviewLayer'
import { AppChrome } from './AppChrome'
import { EmptyState } from './EmptyState'
import DiagOverlay from '../spike/DiagOverlay'
import { isE2E } from '../smoke/e2eRegistry'
import { installE2EHooks } from '../smoke/e2eHooks'

const nodeTypes: NodeTypes = { board: BoardNode }
const FIT_OPTIONS = { padding: 0.2, maxZoom: 1 } as const
/** Single-board focus framing (DESIGN.md §5/§9: ~70px pad, 200ms animate). */
const FOCUS_OPTIONS = { padding: 0.3, maxZoom: Z_MAX, duration: 200 } as const

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

  const rf = useReactFlow()
  const paneRef = useRef<HTMLDivElement>(null)
  // Live native-view count (Browser boards) for the diagnostics overlay.
  const liveViews = usePreviewStore(selectLiveCount)
  // Signal a board drag/resize to the preview layer so it detaches live native
  // views to snapshots for the duration (they'd otherwise paint over the moved board).
  const setNodeGesture = usePreviewStore((s) => s.setNodeGesture)
  // Focused board: camera is fitted to it and (dimOnFocus, fixed-on) others dim.
  const [focusedId, setFocusedId] = useState<string | null>(null)
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
        data: { board: b, dimmed: focusedId !== null && focusedId !== b.id },
        selected: b.id === selectedId,
        dragHandle: '.board-titlebar'
      })),
    [boards, selectedId, focusedId]
  )

  // Translate React Flow changes into store mutations. Position covers both node
  // drag and the origin shift from N/W/NW resize; dimensions (only while actively
  // resizing) covers size; select/remove mirror straight through.
  const onNodesChange = useCallback(
    (changes: NodeChange<BoardFlowNode>[]) => {
      let nextSel: string | null | undefined
      for (const intent of nodeChangesToIntents(changes)) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'select') nextSel = intent.id
        else if (intent.kind === 'deselect') {
          if (nextSel === undefined) nextSel = null
        } else if (intent.kind === 'remove') {
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
      }
      if (nextSel !== undefined) selectBoard(nextSel)
    },
    [updateBoard, resizeBoard, removeBoard, selectBoard]
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
    },
    [rf]
  )

  // Double-click = focus: fit the camera to the board and dim the others. Distinct
  // from Full view (Phase 3), which is a modal layer that doesn't move the camera.
  const focusBoard = useCallback(
    (_e: MouseEvent, node: BoardFlowNode) => {
      setFocusedId(node.id)
      selectBoard(node.id)
      void rf.fitView({ ...FOCUS_OPTIONS, nodes: [{ id: node.id }] })
    },
    [rf, selectBoard]
  )

  // Drag start: checkpoint for undo + detach live preview views (snapshot carries
  // the motion + restores z-order so a dragged board isn't occluded). Stop: reattach.
  const onNodeDragStart = useCallback(() => {
    beginChange()
    setNodeGesture(true)
  }, [beginChange, setNodeGesture])
  const onNodeDragStop = useCallback(() => setNodeGesture(false), [setNodeGesture])

  const clearSelection = useCallback(() => {
    selectBoard(null)
    setFocusedId(null)
  }, [selectBoard])

  // Heal a stale focus (e.g. after undoing the focused board's creation): if the
  // focused board no longer exists, drop focus so others don't stay dimmed.
  // This is intentional derived-state synchronisation (focusedId depends on boards);
  // the eslint-disable-next-line suppresses the react-hooks/set-state-in-effect rule
  // which fires on ANY setState in an effect body, including legitimate cases like this.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
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
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y' && !e.shiftKey && !typing) {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Escape' && !typing) {
        clearSelection()
      } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing) {
        e.preventDefault()
        setDiag((v) => !v)
      } else if (e.key === '1' && !typing) {
        void rf.fitView(FIT_OPTIONS)
      } else if (e.key === '0' && !typing) {
        void rf.zoomTo(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf, clearSelection, undo, redo])

  // E2E (CANVAS_SMOKE=e2e): expose the imperative test hook once the canvas (and its
  // React Flow instance) is live. No-op in every normal run (guarded by isE2E()).
  useEffect(() => {
    if (isE2E()) installE2EHooks(rf)
  }, [rf])

  return (
    <div ref={paneRef} style={paneStyle}>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
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
        <BrowserPreviewLayer paneRef={paneRef} focusedId={focusedId} />
      </ReactFlow>

      {boards.length === 0 && <EmptyState onAdd={addCentered} />}
      <AppChrome onAdd={addCentered} />
      {diag && <DiagOverlay liveViews={liveViews} />}
    </div>
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

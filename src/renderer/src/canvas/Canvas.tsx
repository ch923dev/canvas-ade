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
import { DEFAULT_BOARD_SIZE, type BoardType } from '../lib/boardSchema'
import { GRID_GAP, Z_MAX, Z_MIN, gridDotOpacity } from '../lib/canvasView'
import { BoardNode, type BoardFlowNode } from './BoardNode'
import { BrowserPreviewLayer } from './boards/BrowserPreviewLayer'
import { AppChrome } from './AppChrome'
import { EmptyState } from './EmptyState'
import DiagOverlay from '../spike/DiagOverlay'

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

  const rf = useReactFlow()
  const paneRef = useRef<HTMLDivElement>(null)
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
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          updateBoard(c.id, { x: c.position.x, y: c.position.y })
        } else if (c.type === 'dimensions' && c.dimensions && c.resizing) {
          resizeBoard(c.id, c.dimensions.width, c.dimensions.height)
        } else if (c.type === 'select') {
          if (c.selected) nextSel = c.id
          else if (nextSel === undefined) nextSel = null
        } else if (c.type === 'remove') {
          removeBoard(c.id)
          setFocusedId((f) => (f === c.id ? null : f))
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

  const clearSelection = useCallback(() => {
    selectBoard(null)
    setFocusedId(null)
  }, [selectBoard])

  // Keys: Esc clears, 1 fits, 0 resets zoom, Ctrl/⌘+Shift+D toggles diagnostics.
  // Backspace/Delete deletes the selected board via React Flow's deleteKeyCode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        clearSelection()
      } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        setDiag((v) => !v)
      } else if (e.key === '1') {
        void rf.fitView(FIT_OPTIONS)
      } else if (e.key === '0') {
        void rf.zoomTo(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf, clearSelection])

  return (
    <div ref={paneRef} style={paneStyle}>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        onPaneClick={clearSelection}
        onNodeDoubleClick={focusBoard}
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
        <BrowserPreviewLayer paneRef={paneRef} />
      </ReactFlow>

      {boards.length === 0 && <EmptyState onAdd={addCentered} />}
      <AppChrome onAdd={addCentered} />
      {diag && <DiagOverlay liveViews={0} />}
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

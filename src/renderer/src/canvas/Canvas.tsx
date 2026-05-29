/**
 * The production canvas (2.0-C). A React Flow surface whose nodes are derived from
 * the Zustand board store (store = single source of truth); React Flow changes
 * (drag / resize / select / remove) are translated straight back into store
 * mutations. Camera follows DESIGN.md §5: drag-empty-to-pan, wheel/trackpad pan,
 * Ctrl/⌘+wheel zoom-to-cursor, zoom range 0.1–2.5, dotted grid that fades in the
 * overview band. Boards keep world-space size and degrade to an LOD card < 40%.
 *
 * The bottom add-bar + the initial seed are TEMPORARY 2.0-C scaffolding so the
 * canvas is exercisable now; the real floating app chrome (dock, camera cluster,
 * empty state, focus/dim, keys) lands in 2.0-D and replaces both.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
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
import { TypeGlyph } from './TypeGlyph'
import { Icon } from './Icon'
import DiagOverlay from '../spike/DiagOverlay'

const nodeTypes: NodeTypes = { board: BoardNode }
const FIT_OPTIONS = { padding: 0.2, maxZoom: 1 } as const

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
  const seeded = useRef(false)
  const [diag, setDiag] = useState(import.meta.env.DEV)

  // Controlled nodes: one React Flow node per board, selection mirrored from the
  // store. The title bar is the only drag handle (BoardFrame marks it).
  const nodes = useMemo<BoardFlowNode[]>(
    () =>
      boards.map((b) => ({
        id: b.id,
        type: 'board',
        position: { x: b.x, y: b.y },
        style: { width: b.w, height: b.h },
        data: { board: b },
        selected: b.id === selectedId,
        dragHandle: '.board-titlebar'
      })),
    [boards, selectedId]
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
        }
      }
      if (nextSel !== undefined) selectBoard(nextSel)
    },
    [updateBoard, resizeBoard, removeBoard, selectBoard]
  )

  // Seed one of each board type once, then frame them. TEMP 2.0-C scaffolding.
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    const s = useCanvasStore.getState()
    if (s.boards.length === 0) {
      s.addBoard('planning', { x: -540, y: -180 })
      s.addBoard('terminal', { x: 40, y: -180 })
      s.addBoard('browser', { x: -260, y: 260 })
      s.selectBoard(null)
    }
    requestAnimationFrame(() => rf.fitView(FIT_OPTIONS))
  }, [rf])

  // Diagnostics overlay toggle (Ctrl/⌘+Shift+D) — moves into app chrome in 2.0-D.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        setDiag((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Add a board centered in the current view (TEMP — the dock owns this in 2.0-D).
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

  return (
    <div ref={paneRef} style={paneStyle}>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        onPaneClick={() => selectBoard(null)}
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
      </ReactFlow>

      {/* TEMP 2.0-C add bar — replaced by the floating dock + camera cluster in 2.0-D. */}
      <div style={addBarStyle}>
        <button style={fitBtnStyle} title="Fit (temp)" onClick={() => rf.fitView(FIT_OPTIONS)}>
          <Icon name="fit" size={16} />
        </button>
        <div style={dividerStyle} />
        {(['terminal', 'browser', 'planning'] as const).map((type) => (
          <button key={type} style={addBtnStyle} onClick={() => addCentered(type)}>
            <span style={{ color: 'var(--text-3)', display: 'inline-flex' }}>
              <TypeGlyph type={type} />
            </span>
            <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>+</span>
            {type[0].toUpperCase() + type.slice(1)}
          </button>
        ))}
      </div>

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

const addBarStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 20,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  padding: 4,
  borderRadius: 9,
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  boxShadow: 'var(--shadow-pop)'
}

const addBtnStyle: React.CSSProperties = {
  height: 32,
  padding: '0 11px 0 9px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 12.5,
  fontWeight: 500,
  fontFamily: 'var(--ui)'
}

const fitBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  display: 'grid',
  placeItems: 'center',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--text-3)'
}

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 18,
  background: 'var(--border-subtle)',
  margin: '0 3px'
}

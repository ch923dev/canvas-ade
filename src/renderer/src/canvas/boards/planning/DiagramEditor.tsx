/**
 * Focus-mode diagram EDITOR (diagram Phase 4, ADR 0013) — a nested React Flow instance that replaces
 * the static `DiagramSpecView` while an `engine:'expanse'` card is being edited. Mounts ONLY on focus
 * (DiagramCard gates it), so an unfocused/off-screen diagram never carries a live RF instance (the
 * canvas-perf contract). Its own `ReactFlowProvider` + the `.nowheel/.nopan/.nodrag` carve-out
 * DiagramCard already applies keep the nested pane's wheel/drag from moving the outer board camera.
 *
 * Every gesture is a pure {@link ../../../lib/specEditorOps} mutation, re-validated with `isValidSpec`
 * and committed through `onChangeSpec` (→ boardPatch: undo + revision capture free). The editor never
 * writes an invalid spec. Text renders as React text nodes only (the security contract stands).
 *
 * This module: drag → pos (one undo step per gesture), edge re-route/connect, node/edge delete,
 * inline label/detail edit. The palette (drop new nodes) + T3 comments mount as sibling overlays via
 * the exported context/helpers.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import {
  SPEC_DETAIL_MAX,
  SPEC_LABEL_MAX,
  type DiagramSpec,
  type SpecNode,
  type SpecNodeKind,
  type SpecStatus
} from '../../../lib/diagramSpec'
import {
  addEdge as specAddEdge,
  addNode as specAddNode,
  editNode,
  isValidSpec,
  removeEdge,
  removeNode,
  rerouteEdge,
  setNodePos,
  uniqueSpecId
} from '../../../lib/specEditorOps'
import { DiagramPalette } from './DiagramPalette'
import { specNodeBox, type SpecLayoutResult } from './specLayout'
import {
  specEdgeStyle,
  specKindSilhouette,
  specNodeChrome,
  specStatusStyle,
  specThemePreset,
  type SpecThemePreset
} from './specTheme'
import { SpecNodeBody } from './specNodeVisual'

/** Context so the custom RF node can read the theme/direction and drive inline editing WITHOUT the
 *  node list rebuilding every time `editingId` flips (a node-`data` route would). */
interface EditorCtx {
  direction: DiagramSpec['direction']
  preset: SpecThemePreset
  editingId: string | null
  beginEdit: (id: string) => void
  commitEdit: (id: string, label: string, detail: string) => void
  cancelEdit: () => void
}
const EditorContext = createContext<EditorCtx | null>(null)

interface SpecNodeData extends Record<string, unknown> {
  node: SpecNode
}
type SpecFlowNode = Node<SpecNodeData, 'spec'>

/** spec.nodes → RF nodes. Pinned `pos` wins; else the ELK layout box; else origin. Deterministic
 *  size from `specNodeBox` (== the static view), so a drag never resizes the node. */
function deriveNodes(spec: DiagramSpec, layout: SpecLayoutResult): SpecFlowNode[] {
  return spec.nodes.map((n) => {
    const box = layout.byId.get(n.id)
    const size = specNodeBox(n)
    return {
      id: n.id,
      type: 'spec',
      position: { x: n.pos?.x ?? box?.x ?? 0, y: n.pos?.y ?? box?.y ?? 0 },
      data: { node: n },
      width: size.w,
      height: size.h
    }
  })
}

/** spec.edges → RF edges, styled by the shared specEdgeStyle (both engines stay one palette). */
function deriveEdges(spec: DiagramSpec, preset: SpecThemePreset): Edge[] {
  return spec.edges.map((e) => {
    const st = specEdgeStyle(e, preset)
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
      reconnectable: true,
      style: { stroke: st.stroke, strokeWidth: 1.5, strokeDasharray: st.dasharray || undefined },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: st.stroke },
      labelStyle: { font: '450 10px var(--mono)', fill: 'var(--text-3)' } as CSSProperties,
      labelBgStyle: { fill: 'var(--surface)' } as CSSProperties
    }
  })
}

const HANDLE_STYLE: CSSProperties = {
  width: 8,
  height: 8,
  background: 'var(--surface)',
  border: '1.5px solid var(--accent)'
}

/** Inline label + detail editor rendered inside a node while it is being edited. Enter (either
 *  field) or focus leaving the wrapper commits; Esc cancels. maxLength enforces the spec caps live. */
function InlineNodeEditor({
  node,
  onCommit,
  onCancel
}: {
  node: SpecNode
  onCommit: (label: string, detail: string) => void
  onCancel: () => void
}): ReactElement {
  const [label, setLabel] = useState(node.label)
  const [detail, setDetail] = useState(node.detail ?? '')
  const commit = (): void => onCommit(label, detail)
  const fieldStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    border: 'none',
    outline: 'none',
    background: 'var(--inset)',
    color: 'var(--text)',
    borderRadius: 4,
    padding: '2px 5px'
  }
  const onKey = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div
      className="nodrag nowheel pl-editor-inline"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) commit()
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <input
        autoFocus
        value={label}
        maxLength={SPEC_LABEL_MAX}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={onKey}
        aria-label="Node label"
        style={{ ...fieldStyle, font: '500 12px/16px var(--ui)' }}
      />
      <input
        value={detail}
        maxLength={SPEC_DETAIL_MAX}
        placeholder="detail…"
        onChange={(e) => setDetail(e.target.value)}
        onKeyDown={onKey}
        aria-label="Node detail"
        style={{ ...fieldStyle, font: '450 10px/14px var(--mono)', color: 'var(--text-3)' }}
      />
    </div>
  )
}

/** The custom React Flow node: the shared token chrome/body, plus source/target handles for
 *  drawing + re-routing edges, and the inline editor when this node is being edited. */
function SpecFlowNodeView({ id, data }: NodeProps<SpecFlowNode>): ReactElement {
  const ctx = useContext(EditorContext)
  const n = data.node
  const sil = specKindSilhouette(n.kind)
  const preset = ctx?.preset ?? 'calm'
  const status = specStatusStyle(n.status, preset)
  const editing = ctx?.editingId === id
  const srcPos = ctx?.direction === 'down' ? Position.Bottom : Position.Right
  const tgtPos = ctx?.direction === 'down' ? Position.Top : Position.Left
  return (
    <div
      className="pl-spec-node pl-editor-node"
      onDoubleClick={(e) => {
        e.stopPropagation()
        ctx?.beginEdit(id)
      }}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        ...specNodeChrome(sil, status)
      }}
    >
      <Handle type="target" position={tgtPos} style={HANDLE_STYLE} />
      {editing && ctx ? (
        <InlineNodeEditor
          node={n}
          onCommit={(l, d) => ctx.commitEdit(id, l, d)}
          onCancel={ctx.cancelEdit}
        />
      ) : (
        <SpecNodeBody node={n} sil={sil} status={status} />
      )}
      <Handle type="source" position={srcPos} style={HANDLE_STYLE} />
    </div>
  )
}

const nodeTypes: NodeTypes = { spec: SpecFlowNodeView }

export interface DiagramEditorProps {
  spec: DiagramSpec
  layout: SpecLayoutResult
  /** Card body box (board-local px; header already subtracted by the caller). */
  w: number
  h: number
  /** Arm ONE undo checkpoint at the start of a mutating gesture (drag / edit / drop). */
  onEditStart: () => void
  /** Commit a fresh, already-valid spec (→ boardPatch: undo + revision capture free). */
  onChangeSpec: (next: DiagramSpec) => void
}

/** Inner editor (inside the provider so the RF hooks resolve). */
function DiagramEditorInner({
  spec,
  layout,
  w,
  h,
  onEditStart,
  onChangeSpec
}: DiagramEditorProps): ReactElement {
  const rf = useReactFlow()
  const preset = specThemePreset(spec.theme)
  const [nodes, setNodes, onNodesChange] = useNodesState<SpecFlowNode>(deriveNodes(spec, layout))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(deriveEdges(spec, preset))
  const [editingId, setEditingId] = useState<string | null>(null)

  // Re-derive the RF working copy whenever the spec/layout changes from OUTSIDE the pane (our own
  // commit, an undo, or an agent specOps write). Idempotent for a drag we just committed — the pos
  // is now in the spec. Positions/structure track the spec; RF owns transient selection/drag.
  useEffect(() => {
    setNodes(deriveNodes(spec, layout))
  }, [spec, layout, setNodes])
  useEffect(() => {
    setEdges(deriveEdges(spec, preset))
  }, [spec, preset, setEdges])

  /** Commit a spec mutation IF it is valid — the editor never persists an invalid spec. */
  const commit = useCallback(
    (next: DiagramSpec): void => {
      if (next !== spec && isValidSpec(next)) onChangeSpec(next)
    },
    [spec, onChangeSpec]
  )

  const onNodeDragStop = useCallback(
    (_e: unknown, node: SpecFlowNode): void => {
      const cur = spec.nodes.find((n) => n.id === node.id)
      if (!cur) return
      const pos = { x: Math.round(node.position.x), y: Math.round(node.position.y) }
      if (cur.pos && cur.pos.x === pos.x && cur.pos.y === pos.y) return // no real move
      onEditStart()
      commit(setNodePos(spec, node.id, pos))
    },
    [spec, onEditStart, commit]
  )

  const onReconnect = useCallback(
    (oldEdge: Edge, conn: { source: string | null; target: string | null }): void => {
      if (!conn.source || !conn.target) return
      onEditStart()
      commit(rerouteEdge(spec, oldEdge.id, { from: conn.source, to: conn.target }))
    },
    [spec, onEditStart, commit]
  )

  const onConnect = useCallback(
    (conn: { source: string | null; target: string | null }): void => {
      if (!conn.source || !conn.target || conn.source === conn.target) return
      onEditStart()
      const id = uniqueSpecId(
        `${conn.source}-${conn.target}`,
        spec.edges.map((e) => e.id)
      )
      commit(specAddEdge(spec, { id, from: conn.source, to: conn.target }))
    },
    [spec, onEditStart, commit]
  )

  const onNodesDelete = useCallback(
    (deleted: { id: string }[]): void => {
      onEditStart()
      let next = spec
      for (const d of deleted) next = removeNode(next, d.id)
      commit(next)
    },
    [spec, onEditStart, commit]
  )

  const onEdgesDelete = useCallback(
    (deleted: { id: string }[]): void => {
      onEditStart()
      let next = spec
      for (const d of deleted) next = removeEdge(next, d.id)
      commit(next)
    },
    [spec, onEditStart, commit]
  )

  const commitEdit = useCallback(
    (id: string, label: string, detail: string): void => {
      const cur = spec.nodes.find((n) => n.id === id)
      setEditingId(null)
      if (!cur) return
      const nextLabel = label.trim() || cur.label // empty label keeps the old (assert needs non-empty)
      const nextDetail = detail.trim()
      if (nextLabel === cur.label && nextDetail === (cur.detail ?? '')) return // no change
      onEditStart()
      commit(editNode(spec, id, { label: nextLabel, detail: nextDetail }))
    },
    [spec, onEditStart, commit]
  )

  // Palette drop: place a new node at the current viewport centre (offset a touch per node count so
  // repeated adds don't stack), commit an upsertNode, then open its inline editor so the user names
  // it right away. `pos` is set so the node lands where the user is looking (a pinned drop).
  const onAddNode = useCallback(
    (opts: { kind: SpecNodeKind; status: SpecStatus; icon?: string }): void => {
      const vp = rf.getViewport()
      const off = (spec.nodes.length % 6) * 14
      const cx = (w / 2 - vp.x) / vp.zoom - 84 + off
      const cy = (h / 2 - vp.y) / vp.zoom - 16 + off
      const id = uniqueSpecId(
        opts.kind,
        spec.nodes.map((n) => n.id)
      )
      const node: SpecNode = {
        id,
        label: opts.kind,
        kind: opts.kind,
        pos: { x: Math.round(cx), y: Math.round(cy) },
        ...(opts.status !== 'neutral' ? { status: opts.status } : {}),
        ...(opts.icon ? { icon: opts.icon } : {})
      }
      onEditStart()
      const next = specAddNode(spec, node)
      if (next !== spec && isValidSpec(next)) {
        onChangeSpec(next)
        setEditingId(id)
      }
    },
    [rf, spec, w, h, onEditStart, onChangeSpec]
  )

  const ctx: EditorCtx = {
    direction: spec.direction,
    preset,
    editingId,
    beginEdit: setEditingId,
    commitEdit,
    cancelEdit: () => setEditingId(null)
  }

  return (
    <EditorContext.Provider value={ctx}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onReconnect={onReconnect}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.4 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        className="pl-editor-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--grid-dot)" />
        <DiagramPalette onAddNode={onAddNode} />
      </ReactFlow>
    </EditorContext.Provider>
  )
}

/**
 * The focus-mode editor: its own `ReactFlowProvider` (a nested RF instance, isolated from the app
 * canvas) sized to the card body. `.nowheel/.nopan/.nodrag` on the wrapper hand wheel/drag to the
 * nested pane so the outer board camera never moves while editing.
 */
export function DiagramEditor({ w, h, ...rest }: DiagramEditorProps): ReactElement {
  return (
    <div
      className="pl-editor-root nowheel nopan nodrag"
      style={{ width: w, height: h, position: 'relative', background: 'var(--surface)' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ReactFlowProvider>
        <DiagramEditorInner w={w} h={h} {...rest} />
      </ReactFlowProvider>
    </div>
  )
}

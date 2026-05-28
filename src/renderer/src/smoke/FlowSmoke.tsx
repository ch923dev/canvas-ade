import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

// Custom node = the seed of a future "board". Confirms React Flow renders
// arbitrary React content inside a node and that the dark restyle takes.
function SmokeNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string }
  return (
    <>
      <div className="t">{d.label}</div>
      <div className="s">{d.sub}</div>
    </>
  )
}

const nodeTypes = { smoke: SmokeNode }

const nodes: Node[] = [
  { id: '1', type: 'smoke', position: { x: 0, y: 0 }, data: { label: 'Terminal board', sub: 'agent · main' } },
  { id: '2', type: 'smoke', position: { x: 280, y: 60 }, data: { label: 'Browser board', sub: 'localhost:5173' } },
  { id: '3', type: 'smoke', position: { x: 120, y: 240 }, data: { label: 'Planning board', sub: 'milestone 2' } }
]

export default function FlowSmoke() {
  return (
    <>
      <div className="hint">React Flow · drag to pan · ⌘/Ctrl + wheel to zoom (0.1–2.5)</div>
      <div style={{ position: 'absolute', inset: 0 }}>
        <ReactFlow
          nodes={nodes}
          nodeTypes={nodeTypes}
          minZoom={0.1}
          maxZoom={2.5}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#232327" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </>
  )
}

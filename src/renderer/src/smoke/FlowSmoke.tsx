import { useEffect, useState } from 'react'
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import DiagOverlay from '../spike/DiagOverlay'

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
  {
    id: '1',
    type: 'smoke',
    position: { x: 0, y: 0 },
    data: { label: 'Terminal board', sub: 'agent · main' }
  },
  {
    id: '2',
    type: 'smoke',
    position: { x: 280, y: 60 },
    data: { label: 'Browser board', sub: 'localhost:5173' }
  },
  {
    id: '3',
    type: 'smoke',
    position: { x: 120, y: 240 },
    data: { label: 'Planning board', sub: 'milestone 2' }
  }
]

export default function FlowSmoke() {
  // Diagnostics overlay: on by default in dev, off in packaged builds. The 1-C+
  // sync work reads frame-time/FPS from it. Toggle with Ctrl/⌘+Shift+D.
  const [diag, setDiag] = useState(import.meta.env.DEV)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        setDiag((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      {/* liveViews is 0 until 1-C wires the PreviewManager's WebContentsView count. */}
      {diag && <DiagOverlay liveViews={0} />}
    </>
  )
}

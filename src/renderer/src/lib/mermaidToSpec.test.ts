import { describe, it, expect } from 'vitest'
import { mermaidFlowToSpec } from './mermaidToSpec'
import { SPEC_EDGE_LABEL_MAX, SPEC_LABEL_MAX, SPEC_MAX_NODES } from './diagramSpec'

// Snapshot shapes mirror what resources/diagram-worker/bridge.js __extractFlowchart emits.
interface Flow {
  direction?: unknown
  nodes?: unknown[]
  edges?: unknown[]
  subgraphs?: unknown[]
}
const flow = (over: Flow = {}): Flow => ({
  direction: 'TB',
  nodes: [],
  edges: [],
  subgraphs: [],
  ...over
})

describe('mermaidFlowToSpec', () => {
  it('converts a basic LR flow: 2 nodes + 1 edge → right direction, default kinds', () => {
    const spec = mermaidFlowToSpec(
      flow({
        direction: 'LR',
        nodes: [
          { id: 'a', label: 'Start', shape: 'square' },
          { id: 'b', label: 'End' }
        ],
        edges: [{ from: 'a', to: 'b', label: '', stroke: 'normal' }]
      })
    )
    expect(spec.version).toBe(1)
    expect(spec.direction).toBe('right')
    expect(spec.title).toBeUndefined()
    expect(spec.theme).toBeUndefined()
    expect(spec.nodes).toEqual([
      { id: 'a', label: 'Start' }, // square = unlisted shape ⇒ kind absent (= 'step')
      { id: 'b', label: 'End' }
    ])
    expect(spec.edges).toEqual([{ id: 'e1', from: 'a', to: 'b' }]) // kind absent (= 'flow')
    expect(spec.groups).toBeUndefined()
  })

  it('maps RL → right and everything else (TB/BT/undefined) → down', () => {
    expect(mermaidFlowToSpec(flow({ direction: 'RL' })).direction).toBe('right')
    expect(mermaidFlowToSpec(flow({ direction: 'BT' })).direction).toBe('down')
    expect(mermaidFlowToSpec(flow({ direction: undefined })).direction).toBe('down')
  })

  it('maps diamond/question → decision and cylinder/database → data', () => {
    const spec = mermaidFlowToSpec(
      flow({
        nodes: [
          { id: 'q', label: 'Gate?', shape: 'diamond' },
          { id: 'q2', label: 'Also?', shape: 'question' },
          { id: 'db', label: 'Store', shape: 'cylinder' },
          { id: 'db2', label: 'Store2', shape: 'database' },
          { id: 'svc', label: 'Svc', shape: 'subroutine' },
          { id: 'art', label: 'Art', shape: 'circle' }
        ]
      })
    )
    const kinds = Object.fromEntries(spec.nodes.map((n) => [n.id, n.kind]))
    expect(kinds).toEqual({
      q: 'decision',
      q2: 'decision',
      db: 'data',
      db2: 'data',
      svc: 'service',
      art: 'artifact'
    })
  })

  it('maps a dotted stroke → dependency (thick/normal/absent stay the flow default)', () => {
    const spec = mermaidFlowToSpec(
      flow({
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' }
        ],
        edges: [
          { from: 'a', to: 'b', label: '', stroke: 'dotted' },
          { from: 'b', to: 'a', label: '', stroke: 'thick' }
        ]
      })
    )
    expect(spec.edges[0]).toMatchObject({ id: 'e1', kind: 'dependency' })
    expect(spec.edges[1].kind).toBeUndefined()
  })

  it('slugifies ids and dedupes collisions with _2/_3, keeping edge refs consistent', () => {
    const spec = mermaidFlowToSpec(
      flow({
        nodes: [
          { id: 'a b', label: 'One' },
          { id: 'a/b', label: 'Two' },
          { id: 'a+b', label: 'Three' }
        ],
        edges: [{ from: 'a/b', to: 'a+b', label: '' }]
      })
    )
    expect(spec.nodes.map((n) => n.id)).toEqual(['a_b', 'a_b_2', 'a_b_3'])
    expect(spec.edges).toEqual([{ id: 'e1', from: 'a_b_2', to: 'a_b_3' }])
  })

  it('clamps a colliding slug so the dedupe suffix never exceeds the id cap', () => {
    const long = 'x'.repeat(80) // slugs to the same 64-char base twice
    const spec = mermaidFlowToSpec(
      flow({
        nodes: [
          { id: long, label: 'A' },
          { id: `${long}y`, label: 'B' }
        ]
      })
    )
    expect(spec.nodes[0].id).toBe('x'.repeat(64))
    expect(spec.nodes[1].id).toBe(`${'x'.repeat(62)}_2`)
    expect(spec.nodes[1].id.length).toBe(64)
  })

  it('assigns subgraph membership as groups — unknown members ignored, first subgraph wins', () => {
    const spec = mermaidFlowToSpec(
      flow({
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' }
        ],
        subgraphs: [
          { id: 'g1', title: 'First', nodes: ['a', 'ghost', 'g2'] }, // ghost + nested-subgraph id drop
          { id: 'g2', title: '', nodes: ['a', 'b'] } // 'a' already claimed by g1
        ]
      })
    )
    expect(spec.groups).toEqual([
      { id: 'g1', label: 'First' },
      { id: 'g2', label: 'g2' } // empty title falls back to the slug
    ])
    const byId = Object.fromEntries(spec.nodes.map((n) => [n.id, n.group]))
    expect(byId).toEqual({ a: 'g1', b: 'g2' })
  })

  it('strips control chars from labels and clamps node/edge labels to their caps', () => {
    const bell = String.fromCharCode(7)
    const esc = String.fromCharCode(27)
    const del = String.fromCharCode(127)
    const spec = mermaidFlowToSpec(
      flow({
        nodes: [
          { id: 'a', label: `He${bell}llo${esc} wor${del}ld${'!'.repeat(SPEC_LABEL_MAX)}` },
          { id: 'b', label: `${bell}${esc}` } // strips to empty ⇒ falls back to the slug
        ],
        edges: [{ from: 'a', to: 'b', label: 'e'.repeat(SPEC_EDGE_LABEL_MAX + 40) }]
      })
    )
    expect(spec.nodes[0].label.startsWith('Hello world!')).toBe(true)
    expect(spec.nodes[0].label.length).toBe(SPEC_LABEL_MAX)
    expect(spec.nodes[0].label.includes(bell)).toBe(false)
    expect(spec.nodes[1].label).toBe('b')
    expect(spec.edges[0].label?.length).toBe(SPEC_EDGE_LABEL_MAX)
  })

  it('throws a human message on a non-object flow', () => {
    expect(() => mermaidFlowToSpec(null)).toThrow(/no data/)
    expect(() => mermaidFlowToSpec('graph TD')).toThrow(/no data/)
    expect(() => mermaidFlowToSpec([1, 2])).toThrow(/no data/)
  })

  it('throws "too large" past the node cap', () => {
    const nodes = Array.from({ length: SPEC_MAX_NODES + 1 }, (_, i) => ({
      id: `n${i}`,
      label: `N${i}`
    }))
    expect(() => mermaidFlowToSpec(flow({ nodes }))).toThrow(/too large/)
  })
})

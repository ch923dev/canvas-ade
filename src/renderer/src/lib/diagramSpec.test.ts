import { describe, it, expect } from 'vitest'
import {
  assertDiagramSpec,
  SPEC_MAX_NODES,
  SPEC_MAX_EDGES,
  SPEC_MAX_GROUPS,
  SPEC_ID_MAX,
  SPEC_LABEL_MAX,
  SPEC_DETAIL_MAX,
  SPEC_EDGE_LABEL_MAX,
  type DiagramSpec,
  type SpecNode,
  type SpecEdge
} from './diagramSpec'

// The injected-guard contract (boardSchema.ts passes its own primitives; tests mirror them).
const fail = (msg: string): never => {
  throw new Error(msg)
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const check = (spec: unknown): void => assertDiagramSpec(spec, fail, isRecord, isFiniteNum)

/** A minimal valid spec, spread-overridable per case. */
function base(over: Partial<DiagramSpec> = {}): DiagramSpec {
  return {
    version: 1,
    direction: 'right',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b' }],
    ...over
  }
}

describe('assertDiagramSpec — happy paths', () => {
  it('accepts a minimal spec', () => {
    expect(() => check(base())).not.toThrow()
  })

  it('accepts the full field surface (kinds, statuses, group, pos, href, icon, animated)', () => {
    const spec = base({
      title: 'Pipeline',
      direction: 'down',
      groups: [{ id: 'g1', label: 'Build', collapsed: false, status: 'active' }],
      nodes: [
        {
          id: 'lint',
          label: 'Lint',
          detail: 'eslint 0 errors',
          kind: 'step',
          status: 'done',
          icon: 'check',
          group: 'g1',
          pos: { x: 40, y: 60 },
          href: { file: 'src/main/index.ts', line: 12 }
        },
        { id: 'user', label: 'User', kind: 'actor' }
      ],
      edges: [
        {
          id: 'e1',
          from: 'lint',
          to: 'user',
          label: 'notifies',
          kind: 'dependency',
          status: 'warn',
          animated: true
        }
      ]
    })
    expect(() => check(spec)).not.toThrow()
  })

  it('accepts an empty graph (no nodes, no edges) — a just-created element', () => {
    expect(() => check(base({ nodes: [], edges: [] }))).not.toThrow()
  })

  it('accepts ids using the full slug charset at the length cap', () => {
    const id = 'A9._-'.repeat(12) + 'zzzz' // 64 chars
    expect(id.length).toBe(SPEC_ID_MAX)
    expect(() => check(base({ nodes: [{ id, label: 'X' }], edges: [] }))).not.toThrow()
  })
})

describe('assertDiagramSpec — shape & meta', () => {
  it('rejects a non-object / null spec', () => {
    expect(() => check(null)).toThrow(/not an object/)
    expect(() => check([])).toThrow(/not an object/)
  })

  it('rejects an unsupported version', () => {
    expect(() => check({ ...base(), version: 2 })).toThrow(/unsupported version 2/)
    expect(() => check({ ...base(), version: undefined })).toThrow(/unsupported version/)
  })

  it('rejects a bad direction', () => {
    expect(() => check({ ...base(), direction: 'left' })).toThrow(/direction/)
  })

  it('rejects an over-cap title', () => {
    expect(() => check(base({ title: 'x'.repeat(201) }))).toThrow(/title/)
  })

  it('accepts any non-empty theme string within the cap (OPEN vocabulary — render-side fallback)', () => {
    expect(() => check(base({ theme: 'graphite' }))).not.toThrow()
    expect(() => check(base({ theme: 'some-future-preset' }))).not.toThrow()
    expect(() => check(base({ theme: '' }))).toThrow(/theme/)
    expect(() => check(base({ theme: 'x'.repeat(65) }))).toThrow(/theme/)
    expect(() => check({ ...base(), theme: 7 })).toThrow(/theme/)
  })

  it('rejects non-array nodes/edges', () => {
    expect(() => check({ ...base(), nodes: {} })).toThrow(/nodes is not an array/)
    expect(() => check({ ...base(), nodes: [], edges: {} })).toThrow(/edges is not an array/)
  })
})

describe('assertDiagramSpec — ids', () => {
  it('rejects an empty, over-long, or bad-charset id', () => {
    expect(() => check(base({ nodes: [{ id: '', label: 'X' }], edges: [] }))).toThrow(/node id/)
    expect(() =>
      check(base({ nodes: [{ id: 'x'.repeat(SPEC_ID_MAX + 1), label: 'X' }], edges: [] }))
    ).toThrow(/node id/)
    expect(() => check(base({ nodes: [{ id: 'has space', label: 'X' }], edges: [] }))).toThrow(
      /node id/
    )
    expect(() => check(base({ nodes: [{ id: 'emoji✓', label: 'X' }], edges: [] }))).toThrow(
      /node id/
    )
  })

  it('rejects duplicate ids per namespace (nodes, edges, groups)', () => {
    expect(() =>
      check(
        base({
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'A2' }
          ],
          edges: []
        })
      )
    ).toThrow(/duplicate node id "a"/)
    expect(() =>
      check(
        base({
          edges: [
            { id: 'e1', from: 'a', to: 'b' },
            { id: 'e1', from: 'b', to: 'a' }
          ]
        })
      )
    ).toThrow(/duplicate edge id "e1"/)
    expect(() =>
      check(
        base({
          groups: [
            { id: 'g', label: 'G' },
            { id: 'g', label: 'G2' }
          ]
        })
      )
    ).toThrow(/duplicate group id "g"/)
  })

  it('allows the SAME id across namespaces (node "x" + edge "x" + group "x")', () => {
    const spec = base({
      groups: [{ id: 'x', label: 'G' }],
      nodes: [
        { id: 'x', label: 'A' },
        { id: 'b', label: 'B' }
      ],
      edges: [{ id: 'x', from: 'x', to: 'b' }]
    })
    expect(() => check(spec)).not.toThrow()
  })
})

describe('assertDiagramSpec — caps', () => {
  const nodes = (n: number): SpecNode[] =>
    Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `N${i}` }))

  it('accepts exactly the node cap and rejects one over', () => {
    expect(() => check(base({ nodes: nodes(SPEC_MAX_NODES), edges: [] }))).not.toThrow()
    expect(() => check(base({ nodes: nodes(SPEC_MAX_NODES + 1), edges: [] }))).toThrow(/node cap/)
  })

  it('accepts exactly the edge cap and rejects one over', () => {
    const ns = nodes(2)
    const edges = (n: number): SpecEdge[] =>
      Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: 'n0', to: 'n1' }))
    expect(() => check(base({ nodes: ns, edges: edges(SPEC_MAX_EDGES) }))).not.toThrow()
    expect(() => check(base({ nodes: ns, edges: edges(SPEC_MAX_EDGES + 1) }))).toThrow(/edge cap/)
  })

  it('rejects one over the group cap', () => {
    const groups = Array.from({ length: SPEC_MAX_GROUPS + 1 }, (_, i) => ({
      id: `g${i}`,
      label: `G${i}`
    }))
    expect(() => check(base({ groups }))).toThrow(/group cap/)
  })

  it('enforces the per-field char caps (label, detail, edge label)', () => {
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'x'.repeat(SPEC_LABEL_MAX + 1) }], edges: [] }))
    ).toThrow(/node label/)
    expect(() =>
      check(
        base({
          nodes: [{ id: 'a', label: 'A', detail: 'x'.repeat(SPEC_DETAIL_MAX + 1) }],
          edges: []
        })
      )
    ).toThrow(/node detail/)
    expect(() =>
      check(
        base({
          edges: [{ id: 'e1', from: 'a', to: 'b', label: 'x'.repeat(SPEC_EDGE_LABEL_MAX + 1) }]
        })
      )
    ).toThrow(/edge label/)
  })

  it('rejects an empty node label (labels are required, unlike optional detail)', () => {
    expect(() => check(base({ nodes: [{ id: 'a', label: '' }], edges: [] }))).toThrow(/node label/)
  })
})

describe('assertDiagramSpec — closed vocabularies', () => {
  it('rejects an unknown node kind / status', () => {
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', kind: 'cloud' as never }], edges: [] }))
    ).toThrow(/node kind/)
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', status: 'blocked' as never }], edges: [] }))
    ).toThrow(/status is not in the closed vocabulary/)
  })

  it('rejects an unknown edge kind / status and a non-boolean animated', () => {
    expect(() =>
      check(base({ edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'wire' as never }] }))
    ).toThrow(/edge kind/)
    expect(() =>
      check(base({ edges: [{ id: 'e1', from: 'a', to: 'b', status: 'red' as never }] }))
    ).toThrow(/status is not in the closed vocabulary/)
    expect(() =>
      check(base({ edges: [{ id: 'e1', from: 'a', to: 'b', animated: 1 as never }] }))
    ).toThrow(/animated/)
  })

  it('rejects an unknown group status', () => {
    expect(() =>
      check(base({ groups: [{ id: 'g', label: 'G', status: 'huge' as never }] }))
    ).toThrow(/status is not in the closed vocabulary/)
  })
})

describe('assertDiagramSpec — referential integrity', () => {
  it('rejects a dangling edge endpoint (from and to)', () => {
    expect(() => check(base({ edges: [{ id: 'e1', from: 'ghost', to: 'b' }] }))).toThrow(
      /from references unknown node "ghost"/
    )
    expect(() => check(base({ edges: [{ id: 'e1', from: 'a', to: 'ghost' }] }))).toThrow(
      /to references unknown node "ghost"/
    )
  })

  it('rejects a node referencing an unknown group', () => {
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', group: 'ghost' }], edges: [] }))
    ).toThrow(/references unknown group "ghost"/)
  })

  it('accepts a self-loop edge (from === to is a valid graph shape)', () => {
    expect(() => check(base({ edges: [{ id: 'e1', from: 'a', to: 'a' }] }))).not.toThrow()
  })
})

describe('assertDiagramSpec — pos & href', () => {
  it('rejects a non-finite pos', () => {
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', pos: { x: NaN, y: 0 } }], edges: [] }))
    ).toThrow(/pos/)
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', pos: { x: 0, y: Infinity } }], edges: [] }))
    ).toThrow(/pos/)
  })

  it('rejects a bad href (empty file, non-integer or non-positive line)', () => {
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', href: { file: '' } }], edges: [] }))
    ).toThrow(/href file/)
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', href: { file: 'f.ts', line: 0 } }], edges: [] }))
    ).toThrow(/href line/)
    expect(() =>
      check(
        base({ nodes: [{ id: 'a', label: 'A', href: { file: 'f.ts', line: 1.5 } }], edges: [] })
      )
    ).toThrow(/href line/)
  })

  it('accepts href without a line (open-at-top, the kanban fileRef contract)', () => {
    expect(() =>
      check(base({ nodes: [{ id: 'a', label: 'A', href: { file: 'src/x.ts' } }], edges: [] }))
    ).not.toThrow()
  })
})

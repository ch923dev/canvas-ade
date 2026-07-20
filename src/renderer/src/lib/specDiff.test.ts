import { describe, expect, it } from 'vitest'
import type { DiagramSpec } from './diagramSpec'
import { diffSpecs, lintSpec } from './specDiff'

/** Phase 3: the semantic differ + lint feeding the Option-B confirm body. */

const spec = (over: Partial<DiagramSpec> = {}): DiagramSpec => ({
  version: 1,
  direction: 'right',
  nodes: [
    { id: 'plan', label: 'Plan', status: 'done' },
    { id: 'build', label: 'Build', status: 'active' }
  ],
  edges: [{ id: 'e1', from: 'plan', to: 'build', kind: 'flow' }],
  ...over
})

describe('diffSpecs', () => {
  it('emit (prev=null): everything added, grouped by namespace', () => {
    const d = diffSpecs(null, spec({ groups: [{ id: 'g1', label: 'CI' }] }))
    expect(d.sections.map((s) => s.title)).toEqual(['Nodes', 'Edges', 'Groups'])
    expect(d.added).toBe(4)
    expect(d.changed + d.removed).toBe(0)
    expect(d.sections[0].rows[0]).toEqual({
      sig: '+',
      text: 'node plan "Plan" (step · done)'
    })
  })

  it('edit: adds, field-level changes, and removes in their own sections', () => {
    const prev = spec()
    const next = spec({
      nodes: [
        { id: 'plan', label: 'Plan', status: 'done' },
        { id: 'build', label: 'Build', status: 'done' },
        { id: 'deploy', label: 'Deploy to prod', kind: 'step' }
      ],
      edges: [{ id: 'e2', from: 'build', to: 'deploy' }]
    })
    const d = diffSpecs(prev, next)
    expect(d.sections.map((s) => s.title)).toEqual(['Added', 'Changed', 'Removed'])
    expect(d.added).toBe(2) // node deploy + edge e2
    expect(d.changed).toBe(1)
    expect(d.removed).toBe(1) // edge e1
    const changed = d.sections.find((s) => s.title === 'Changed')
    expect(changed?.rows[0].text).toBe('node build · status active → done')
  })

  it('identical specs (any key order) diff to zero rows — the no-op signal', () => {
    const prev = spec()
    const reordered = JSON.parse(
      JSON.stringify({
        edges: prev.edges.map((e) => ({ kind: e.kind, to: e.to, from: e.from, id: e.id })),
        nodes: prev.nodes.map((n) => ({ status: n.status, label: n.label, id: n.id })),
        direction: prev.direction,
        version: prev.version
      })
    ) as DiagramSpec
    const d = diffSpecs(prev, reordered)
    expect(d.added + d.changed + d.removed).toBe(0)
    expect(d.sections).toHaveLength(0)
  })

  it('meta changes (title/direction/theme) read as ~ rows', () => {
    const d = diffSpecs(spec(), spec({ theme: 'graphite', title: 'Pipeline' }))
    const texts = d.sections.flatMap((s) => s.rows.map((r) => r.text))
    expect(texts).toContain('diagram title (none) → Pipeline')
    expect(texts).toContain('diagram theme (none) → graphite')
  })
})

describe('lintSpec', () => {
  it('flags a disconnected node only when the spec HAS edges, and never a note node', () => {
    const lonely = spec({
      nodes: [
        { id: 'plan', label: 'Plan' },
        { id: 'build', label: 'Build' },
        { id: 'island', label: 'Island' },
        { id: 'memo', label: 'Memo', kind: 'note' }
      ]
    })
    const warnings = lintSpec(lonely)
    expect(warnings.some((w) => w.includes('island'))).toBe(true)
    expect(warnings.some((w) => w.includes('memo'))).toBe(false)
    // Edge-less spec: a pure node inventory is a legitimate early shape — no warnings.
    expect(lintSpec(spec({ edges: [], nodes: [{ id: 'a', label: 'A' }] }))).toEqual([])
  })

  it('flags duplicate from→to pairs and self-loops', () => {
    const w = lintSpec(
      spec({
        edges: [
          { id: 'e1', from: 'plan', to: 'build' },
          { id: 'e2', from: 'plan', to: 'build' },
          { id: 'e3', from: 'build', to: 'build' }
        ]
      })
    )
    expect(w.some((x) => x.includes('parallel edges plan→build'))).toBe(true)
    expect(w.some((x) => x.includes('loops build onto itself'))).toBe(true)
  })

  it('flags a group with no member nodes', () => {
    const w = lintSpec(spec({ groups: [{ id: 'g1', label: 'Empty pen' }] }))
    expect(w.some((x) => x.includes('Empty pen'))).toBe(true)
  })

  it('a clean spec lints clean', () => {
    expect(lintSpec(spec())).toEqual([])
  })
})

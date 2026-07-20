import { describe, it, expect } from 'vitest'
import { withSpecRevisions } from './specRevisions'
import { DIAGRAM_REVISION_CAP, type PlanningElement } from './boardSchema'
import type { DiagramSpec } from './diagramSpec'

const spec = (label: string): DiagramSpec => ({
  version: 1,
  direction: 'right',
  nodes: [{ id: 'a', label }],
  edges: []
})

const diagram = (over: Partial<Extract<PlanningElement, { kind: 'diagram' }>> = {}) =>
  ({
    id: 'd1',
    kind: 'diagram',
    engine: 'expanse',
    spec: spec('A'),
    x: 0,
    y: 0,
    w: 280,
    h: 200,
    ...over
  }) as PlanningElement

const note: PlanningElement = {
  id: 'n1',
  kind: 'note',
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  text: 'hi',
  tint: 'yellow'
} as PlanningElement

describe('withSpecRevisions — the boardPatch capture (v22, B4)', () => {
  it('captures the DISPLACED spec when a patch replaces it (author + ts stamped)', () => {
    const prev = [note, diagram()]
    const next = [note, diagram({ spec: spec('B') })]
    const out = withSpecRevisions(prev, next, 123)
    const d = out[1] as Extract<PlanningElement, { kind: 'diagram' }>
    expect(d.spec).toEqual(spec('B')) // the live head is the incoming spec
    expect(d.revisions).toEqual([{ spec: spec('A'), ts: 123, author: 'agent' }])
  })

  it('appends to existing history oldest→newest and rolls the oldest off past the cap', () => {
    const history = Array.from({ length: DIAGRAM_REVISION_CAP }, (_, i) => ({
      spec: spec(`old${i}`),
      ts: i,
      author: 'agent' as const
    }))
    const prev = [diagram({ revisions: history })]
    const next = [diagram({ spec: spec('B') })] // incoming patch built from live els may drop nothing
    const out = withSpecRevisions(prev, next, 999)
    const d = out[0] as Extract<PlanningElement, { kind: 'diagram' }>
    expect(d.revisions).toHaveLength(DIAGRAM_REVISION_CAP)
    expect(d.revisions![0]!.spec).toEqual(spec('old1')) // old0 rolled off
    expect(d.revisions!.at(-1)).toEqual({ spec: spec('A'), ts: 999, author: 'agent' })
  })

  it('is the identity (same ref) when no spec content changed — fresh-but-equal objects included', () => {
    const prev = [diagram()]
    const next = [diagram()] // new object, same content — must NOT mint a phantom revision
    expect(withSpecRevisions(prev, next, 1)).toBe(next)
  })

  it('ignores non-diagram, mermaid, and newly-added elements (no prior spec to displace)', () => {
    const prevMermaid = [
      { ...diagram({ id: 'm1' }), engine: 'mermaid', spec: undefined, source: 'graph TD' }
    ] as PlanningElement[]
    const nextMermaid = [
      { ...diagram({ id: 'm1' }), engine: 'mermaid', spec: undefined, source: 'graph LR' }
    ] as PlanningElement[]
    expect(withSpecRevisions(prevMermaid, nextMermaid, 1)).toBe(nextMermaid)
    // brand-new expanse element — nothing displaced
    const added = [diagram({ id: 'new1', spec: spec('N') })]
    expect(withSpecRevisions([note], [note, ...added], 1)).toEqual([note, ...added])
  })

  it('threads an explicit author (the Phase-4 user editor path)', () => {
    const out = withSpecRevisions([diagram()], [diagram({ spec: spec('B') })], 5, 'user')
    const d = out[0] as Extract<PlanningElement, { kind: 'diagram' }>
    expect(d.revisions![0]!.author).toBe('user')
  })
})

import { describe, it, expect } from 'vitest'
import { orchestrationEdges } from './orchestrationEdges'
import { createBoard, type Board, type Connector } from './boardSchema'

const boards = (): Board[] => [
  createBoard('terminal', { id: 't1', x: 0, y: 0 }),
  createBoard('browser', { id: 'b1', x: 800, y: 0 }),
  createBoard('planning', { id: 'p1', x: 0, y: 600 })
]

const conn = (
  id: string,
  sourceId: string,
  targetId: string,
  kind: Connector['kind']
): Connector => ({
  id,
  sourceId,
  targetId,
  kind
})

describe('orchestrationEdges', () => {
  it('maps each orchestration connector to a typed RF edge', () => {
    const out = orchestrationEdges([conn('o1', 't1', 'b1', 'orchestration')], boards())
    expect(out).toEqual([{ id: 'o1', source: 't1', target: 'b1', type: 'orchestration' }])
  })

  it('ignores preview connectors (only orchestration cables render here)', () => {
    expect(orchestrationEdges([conn('preview-b1', 't1', 'b1', 'preview')], boards())).toEqual([])
  })

  it('skips a dangling connector (an endpoint board is gone) — no half-edge', () => {
    const cs = [
      conn('o1', 't1', 'gone', 'orchestration'),
      conn('o2', 'gone', 'p1', 'orchestration')
    ]
    expect(orchestrationEdges(cs, boards())).toEqual([])
  })

  it('preserves order and supports multiple cables', () => {
    const out = orchestrationEdges(
      [conn('o1', 't1', 'b1', 'orchestration'), conn('o2', 't1', 'p1', 'orchestration')],
      boards()
    )
    expect(out.map((e) => e.id)).toEqual(['o1', 'o2'])
  })

  it('returns an empty array for no connectors', () => {
    expect(orchestrationEdges([], boards())).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { DiagramSpec } from '@expanse-ade/diagram/spec'
import { applySpecOps } from './specOps'

/**
 * Phase 3: the pure specOps apply semantics BOTH bundles share (MAIN's gate pre-validates the
 * result of exactly this function; the renderer applier re-runs it against the live spec).
 */

const base = (): DiagramSpec => ({
  version: 1,
  title: 'Deploy pipeline',
  direction: 'right',
  nodes: [
    { id: 'plan', label: 'Plan', status: 'done' },
    { id: 'build', label: 'Build', status: 'active', group: 'g1' },
    { id: 'test', label: 'Test' }
  ],
  edges: [
    { id: 'e1', from: 'plan', to: 'build' },
    { id: 'e2', from: 'build', to: 'test' }
  ],
  groups: [{ id: 'g1', label: 'CI' }]
})

describe('applySpecOps — pure, ordered, idempotent-by-id', () => {
  it('upsertNode replaces by id, else appends', () => {
    const out = applySpecOps(base(), [
      { op: 'upsertNode', node: { id: 'build', label: 'Build', status: 'done' } },
      { op: 'upsertNode', node: { id: 'deploy', label: 'Deploy' } }
    ])
    expect(out.nodes).toHaveLength(4)
    expect(out.nodes.find((n) => n.id === 'build')).toEqual({
      id: 'build',
      label: 'Build',
      status: 'done'
    })
    expect(out.nodes[3]).toEqual({ id: 'deploy', label: 'Deploy' })
  })

  it('upsert is a FULL replace — omitted optional fields drop (no silent merge)', () => {
    const out = applySpecOps(base(), [{ op: 'upsertNode', node: { id: 'build', label: 'Build' } }])
    const build = out.nodes.find((n) => n.id === 'build')
    expect(build?.status).toBeUndefined()
    expect(build?.group).toBeUndefined()
  })

  it('removeNode cascades the edges touching it', () => {
    const out = applySpecOps(base(), [{ op: 'removeNode', id: 'build' }])
    expect(out.nodes.map((n) => n.id)).toEqual(['plan', 'test'])
    expect(out.edges).toHaveLength(0)
  })

  it('removeGroup clears member refs but keeps the nodes', () => {
    const out = applySpecOps(base(), [{ op: 'removeGroup', id: 'g1' }])
    expect(out.groups).toBeUndefined()
    expect(out.nodes.find((n) => n.id === 'build')?.group).toBeUndefined()
    expect(out.nodes).toHaveLength(3)
  })

  it('removes of an unknown id are no-ops (idempotent deletes)', () => {
    const out = applySpecOps(base(), [
      { op: 'removeNode', id: 'nope' },
      { op: 'removeEdge', id: 'nope' },
      { op: 'removeGroup', id: 'nope' }
    ])
    expect(out.nodes).toHaveLength(3)
    expect(out.edges).toHaveLength(2)
    expect(out.groups).toHaveLength(1)
  })

  it('setMeta overwrites only the present fields', () => {
    const out = applySpecOps(base(), [{ op: 'setMeta', theme: 'graphite' }])
    expect(out.title).toBe('Deploy pipeline')
    expect(out.direction).toBe('right')
    expect(out.theme).toBe('graphite')
  })

  it('an edge may arrive before the node a later op adds (result-judged, not order-judged)', () => {
    const out = applySpecOps(base(), [
      { op: 'upsertEdge', edge: { id: 'e3', from: 'test', to: 'deploy' } },
      { op: 'upsertNode', node: { id: 'deploy', label: 'Deploy' } }
    ])
    expect(out.edges.find((e) => e.id === 'e3')).toBeDefined()
    expect(out.nodes.find((n) => n.id === 'deploy')).toBeDefined()
  })

  it('never mutates the input spec', () => {
    const input = base()
    const snapshot = JSON.parse(JSON.stringify(input))
    applySpecOps(input, [
      { op: 'removeNode', id: 'build' },
      { op: 'setMeta', title: 'X' },
      { op: 'removeGroup', id: 'g1' }
    ])
    expect(input).toEqual(snapshot)
  })
})

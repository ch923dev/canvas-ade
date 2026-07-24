import { describe, it, expect } from 'vitest'
import type { DiagramSpec } from './diagramSpec'
import {
  addEdge,
  addNode,
  editNode,
  isValidSpec,
  removeEdge,
  removeNode,
  rerouteEdge,
  setNodePos,
  unpinNode,
  uniqueSpecId
} from './specEditorOps'

/** A small valid spec: build → test → deploy, with build pinned. */
function base(): DiagramSpec {
  return {
    version: 1,
    direction: 'right',
    nodes: [
      { id: 'build', label: 'build', pos: { x: 10, y: 20 } },
      { id: 'test', label: 'test', status: 'done', detail: 'unit + e2e' },
      { id: 'deploy', label: 'deploy', kind: 'service', status: 'active' }
    ],
    edges: [
      { id: 'e1', from: 'build', to: 'test' },
      { id: 'e2', from: 'test', to: 'deploy' }
    ]
  }
}

describe('specEditorOps — purity', () => {
  it('never mutates the input spec', () => {
    const spec = base()
    const snapshot = JSON.parse(JSON.stringify(spec))
    setNodePos(spec, 'test', { x: 1, y: 2 })
    rerouteEdge(spec, 'e1', { to: 'deploy' })
    removeNode(spec, 'build')
    expect(spec).toEqual(snapshot)
  })
})

describe('editNode', () => {
  it('merges a label edit, keeping other fields', () => {
    const out = editNode(base(), 'test', { label: 'run tests' })
    const n = out.nodes.find((x) => x.id === 'test')!
    expect(n.label).toBe('run tests')
    expect(n.status).toBe('done')
    expect(n.detail).toBe('unit + e2e')
  })

  it('drops detail when set to empty string', () => {
    const out = editNode(base(), 'test', { detail: '' })
    expect(out.nodes.find((x) => x.id === 'test')!.detail).toBeUndefined()
  })

  it('sets and clears the icon field', () => {
    const withIcon = editNode(base(), 'deploy', { icon: 'rocket' })
    expect(withIcon.nodes.find((x) => x.id === 'deploy')!.icon).toBe('rocket')
    const cleared = editNode(withIcon, 'deploy', { icon: '' })
    expect(cleared.nodes.find((x) => x.id === 'deploy')!.icon).toBeUndefined()
  })

  it('updates kind and status', () => {
    const out = editNode(base(), 'build', { kind: 'artifact', status: 'warn' })
    const n = out.nodes.find((x) => x.id === 'build')!
    expect(n.kind).toBe('artifact')
    expect(n.status).toBe('warn')
  })

  it('is a no-op for a missing node id', () => {
    const spec = base()
    expect(editNode(spec, 'ghost', { label: 'x' })).toEqual(spec)
  })
})

describe('setNodePos / unpinNode', () => {
  it('pins a node at a position', () => {
    const out = setNodePos(base(), 'test', { x: 200, y: 80 })
    expect(out.nodes.find((x) => x.id === 'test')!.pos).toEqual({ x: 200, y: 80 })
  })

  it('re-pins an already-pinned node', () => {
    const out = setNodePos(base(), 'build', { x: 5, y: 5 })
    expect(out.nodes.find((x) => x.id === 'build')!.pos).toEqual({ x: 5, y: 5 })
  })

  it('unpins a node back to auto-layout', () => {
    const out = unpinNode(base(), 'build')
    expect(out.nodes.find((x) => x.id === 'build')!.pos).toBeUndefined()
  })
})

describe('rerouteEdge', () => {
  it('re-routes the target endpoint', () => {
    const out = rerouteEdge(base(), 'e1', { to: 'deploy' })
    const e = out.edges.find((x) => x.id === 'e1')!
    expect(e.from).toBe('build')
    expect(e.to).toBe('deploy')
  })

  it('re-routes the source endpoint', () => {
    const out = rerouteEdge(base(), 'e2', { from: 'build' })
    expect(out.edges.find((x) => x.id === 'e2')!.from).toBe('build')
  })

  it('re-routes both endpoints and preserves the edge label/kind', () => {
    const spec = base()
    spec.edges[0].label = 'compiled'
    spec.edges[0].kind = 'dependency'
    const out = rerouteEdge(spec, 'e1', { from: 'test', to: 'deploy' })
    const e = out.edges.find((x) => x.id === 'e1')!
    expect(e.from).toBe('test')
    expect(e.to).toBe('deploy')
    expect(e.label).toBe('compiled')
    expect(e.kind).toBe('dependency')
  })

  it('is a no-op for a missing edge id', () => {
    const spec = base()
    expect(rerouteEdge(spec, 'nope', { to: 'deploy' })).toEqual(spec)
  })
})

describe('addNode / addEdge / removeNode / removeEdge', () => {
  it('adds a node (palette drop)', () => {
    const out = addNode(base(), { id: 'lint', label: 'lint', kind: 'step', pos: { x: 0, y: 120 } })
    expect(out.nodes.map((n) => n.id)).toContain('lint')
    expect(isValidSpec(out)).toBe(true)
  })

  it('adds an edge between existing nodes', () => {
    const out = addEdge(base(), { id: 'e3', from: 'build', to: 'deploy' })
    expect(out.edges.map((e) => e.id)).toContain('e3')
    expect(isValidSpec(out)).toBe(true)
  })

  it('removeNode cascades edges touching it', () => {
    const out = removeNode(base(), 'test')
    expect(out.nodes.map((n) => n.id)).not.toContain('test')
    // e1 (build→test) and e2 (test→deploy) both cascade away.
    expect(out.edges).toHaveLength(0)
    expect(isValidSpec(out)).toBe(true)
  })

  it('removeEdge drops just that edge', () => {
    const out = removeEdge(base(), 'e1')
    expect(out.edges.map((e) => e.id)).toEqual(['e2'])
    expect(isValidSpec(out)).toBe(true)
  })
})

describe('uniqueSpecId', () => {
  it('returns a sanitized base when free', () => {
    expect(uniqueSpecId('New Step!', [])).toBe('New-Step')
  })

  it('suffixes on collision', () => {
    expect(uniqueSpecId('step', ['step'])).toBe('step-2')
    expect(uniqueSpecId('step', ['step', 'step-2'])).toBe('step-3')
  })

  it('falls back to "node" for an all-invalid base', () => {
    expect(uniqueSpecId('!!!', [])).toBe('node')
  })

  it('never exceeds the id cap', () => {
    const long = 'x'.repeat(200)
    expect(uniqueSpecId(long, []).length).toBeLessThanOrEqual(64)
  })

  it('produces ids that pass the spec id validator', () => {
    const id = uniqueSpecId('Deploy → prod (v2)', ['deploy'])
    const out = addNode(base(), { id, label: 'new' })
    expect(isValidSpec(out)).toBe(true)
  })
})

describe('isValidSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(isValidSpec(base())).toBe(true)
  })

  it('rejects a dangling edge endpoint', () => {
    const spec = base()
    spec.edges.push({ id: 'bad', from: 'build', to: 'ghost' })
    expect(isValidSpec(spec)).toBe(false)
  })

  it('rejects a duplicate node id', () => {
    const spec = base()
    spec.nodes.push({ id: 'build', label: 'dup' })
    expect(isValidSpec(spec)).toBe(false)
  })

  it('rejects a label over the cap', () => {
    const spec = base()
    spec.nodes[0].label = 'x'.repeat(201)
    expect(isValidSpec(spec)).toBe(false)
  })
})

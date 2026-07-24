import { describe, expect, it } from 'vitest'
import type { DiagramSpec } from '@expanse-ade/diagram/spec'
import {
  buildDiagramSpec,
  buildPlanningConfirmDiff,
  buildPlanningOps,
  MAX_DIAGRAM_SPEC_BYTES,
  PlanningContentError
} from './mcpPlanning'
import { buildPlanningUpdateOp, buildSpecOpsConfirmDiff, MAX_SPEC_OPS } from './mcpPlanningEdit'

/**
 * Diagram Phase 3 (MCP contract v2): MAIN-authoritative validation for structured-spec diagram
 * writes — the emit form on `add_planning_elements` (`engine:'expanse'` + spec, judged by the
 * renderer's own `assertDiagramSpec` plus the MCP-specific control-char reject + 16 KB bound) and
 * the `specOps` incremental patch on `update_planning_element` (ops applied against the current
 * spec, the RESULT judged by the same gate, no-op batches rejected).
 */

const validSpec = (over: Partial<DiagramSpec> = {}): DiagramSpec => ({
  version: 1,
  direction: 'right',
  nodes: [
    { id: 'plan', label: 'Plan', status: 'done' },
    { id: 'build', label: 'Build', status: 'active' }
  ],
  edges: [{ id: 'e1', from: 'plan', to: 'build' }],
  ...over
})

describe('emit — buildPlanningOps diagram spec form', () => {
  it('accepts engine:"expanse" + a valid spec (clone, not the caller reference)', () => {
    const spec = validSpec()
    const ops = buildPlanningOps([{ kind: 'diagram', engine: 'expanse', spec }])
    expect(ops[0]).toEqual({ kind: 'diagram', engine: 'expanse', spec })
    const op = ops[0] as Extract<(typeof ops)[number], { kind: 'diagram'; engine: 'expanse' }>
    expect(op.spec).not.toBe(spec)
  })

  it('accepts a bare spec with engine absent (expanse implied by the form)', () => {
    const ops = buildPlanningOps([{ kind: 'diagram', spec: validSpec() }])
    expect(ops[0]).toMatchObject({ kind: 'diagram', engine: 'expanse' })
  })

  it('rejects both/neither content forms and engine mismatches', () => {
    const spec = validSpec()
    expect(() => buildPlanningOps([{ kind: 'diagram', source: 'graph TD\n A-->B', spec }])).toThrow(
      PlanningContentError
    )
    expect(() => buildPlanningOps([{ kind: 'diagram' }])).toThrow(PlanningContentError)
    expect(() => buildPlanningOps([{ kind: 'diagram', engine: 'mermaid', spec }])).toThrow(
      PlanningContentError
    )
    expect(() =>
      buildPlanningOps([{ kind: 'diagram', engine: 'expanse', source: 'graph TD\n A-->B' }])
    ).toThrow(PlanningContentError)
  })

  it('rejects a spec that fails the canonical validator (dangling edge)', () => {
    const bad = validSpec({ edges: [{ id: 'e1', from: 'plan', to: 'ghost' }] })
    expect(() => buildPlanningOps([{ kind: 'diagram', spec: bad }])).toThrow(
      /references unknown node/
    )
  })

  it('REJECTS control characters in spec strings (no silent sanitize — authoring bug surfaced)', () => {
    const bad = validSpec({
      nodes: [{ id: 'a', label: 'evil[31mred' }],
      edges: []
    })
    expect(() => buildPlanningOps([{ kind: 'diagram', spec: bad }])).toThrow(/control character/)
  })

  it('rejects a spec over the 16 KB serialized bound while every field cap passes', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
      detail: 'd'.repeat(190)
    }))
    const bad = validSpec({ nodes, edges: [] })
    expect(() => buildDiagramSpec(bad, 'test')).toThrow(new RegExp(String(MAX_DIAGRAM_SPEC_BYTES)))
  })

  it('buildPlanningConfirmDiff: present only for spec diagrams; all-added sections + lint', () => {
    expect(
      buildPlanningConfirmDiff(buildPlanningOps([{ kind: 'note', text: 'x' }]))
    ).toBeUndefined()
    const withIsland = validSpec({
      nodes: [...validSpec().nodes, { id: 'island', label: 'Island' }]
    })
    const diff = buildPlanningConfirmDiff(
      buildPlanningOps([
        { kind: 'diagram', spec: withIsland },
        { kind: 'note', text: 'ctx' }
      ])
    )
    expect(diff).toBeDefined()
    expect(diff?.summary).toContain('3 node(s)')
    expect(diff?.sections.map((s) => s.title)).toEqual(['Nodes', 'Edges'])
    expect(diff?.lints.some((w) => w.includes('island'))).toBe(true)
  })
})

describe('edit — buildPlanningUpdateOp specOps', () => {
  const diagram = { engine: 'expanse', spec: validSpec() }

  it('accepts a valid batch: patch carries cloned ops, nextSpec is the validated result', () => {
    const { op, nextSpec } = buildPlanningUpdateOp(
      'd1',
      'diagram',
      {
        specOps: [
          { op: 'upsertNode', node: { id: 'deploy', label: 'Deploy' } },
          { op: 'upsertEdge', edge: { id: 'e2', from: 'build', to: 'deploy' } }
        ]
      },
      diagram
    )
    expect(op.patch.specOps).toHaveLength(2)
    expect(nextSpec?.nodes.map((n) => n.id)).toEqual(['plan', 'build', 'deploy'])
  })

  it('rejects specOps on a Mermaid / legacy diagram, and source on an expanse one', () => {
    expect(() =>
      buildPlanningUpdateOp(
        'd1',
        'diagram',
        { specOps: [{ op: 'removeNode', id: 'x' }] },
        { engine: 'mermaid' }
      )
    ).toThrow(/applies only to a structured/)
    expect(() =>
      buildPlanningUpdateOp(
        'd1',
        'diagram',
        { specOps: [{ op: 'removeNode', id: 'x' }] },
        undefined
      )
    ).toThrow(/applies only to a structured/)
    expect(() =>
      buildPlanningUpdateOp('d1', 'diagram', { source: 'graph TD\n A-->B' }, diagram)
    ).toThrow(/edited via "specOps"/)
    expect(() =>
      buildPlanningUpdateOp(
        'd1',
        'diagram',
        { source: 'graph TD\n A-->B', specOps: [{ op: 'removeNode', id: 'x' }] },
        diagram
      )
    ).toThrow(/not both/)
  })

  it('rejects a batch when the mirror carries no spec (stale mirror)', () => {
    expect(() =>
      buildPlanningUpdateOp(
        'd1',
        'diagram',
        { specOps: [{ op: 'removeNode', id: 'plan' }] },
        { engine: 'expanse' }
      )
    ).toThrow(/stale mirror/)
  })

  it('rejects a batch that nets to NO change (typo-id removes)', () => {
    expect(() =>
      buildPlanningUpdateOp(
        'd1',
        'diagram',
        { specOps: [{ op: 'removeNode', id: 'buld' }] },
        diagram
      )
    ).toThrow(/no change/)
  })

  it('rejects when the RESULT fails the canonical validator (edge to a node the batch removed)', () => {
    expect(() =>
      buildPlanningUpdateOp(
        'd1',
        'diagram',
        {
          specOps: [{ op: 'upsertEdge', edge: { id: 'e9', from: 'plan', to: 'ghost' } }]
        },
        diagram
      )
    ).toThrow(/references unknown node/)
  })

  it('rejects unknown op kinds and an over-cap batch', () => {
    expect(() =>
      buildPlanningUpdateOp('d1', 'diagram', { specOps: [{ op: 'explode', id: 'x' }] }, diagram)
    ).toThrow(/not a recognized op/)
    const many = Array.from({ length: MAX_SPEC_OPS + 1 }, (_, i) => ({
      op: 'removeNode',
      id: `n${i}`
    }))
    expect(() => buildPlanningUpdateOp('d1', 'diagram', { specOps: many }, diagram)).toThrow(
      new RegExp(String(MAX_SPEC_OPS))
    )
  })

  it('buildSpecOpsConfirmDiff: summary counts + sections + lint over the PROPOSED spec', () => {
    const current = validSpec()
    const { nextSpec } = buildPlanningUpdateOp(
      'd1',
      'diagram',
      { specOps: [{ op: 'removeEdge', id: 'e1' }] },
      { engine: 'expanse', spec: current }
    )
    const diff = buildSpecOpsConfirmDiff(current, nextSpec as DiagramSpec)
    expect(diff.summary).toContain('−1')
    expect(diff.sections.map((s) => s.title)).toEqual(['Removed'])
    // Removing the only edge leaves an edge-less spec → the disconnected rule stands down.
    expect(diff.lints).toEqual([])
  })
})

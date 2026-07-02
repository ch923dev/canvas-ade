import { describe, it, expect } from 'vitest'
import { buildVisualizedContent, isVisualization } from './visualizeMcpApply'
import type { PlanItem } from '../../../shared/mcpTypes'

const PLAN: PlanItem[] = [
  { title: 'Audit token flow', status: 'Backlog', tag: 'research' },
  { title: 'Wire PKCE', status: 'In Progress', assignee: 'claude' },
  { title: 'Wire callback', status: 'In Progress', assignee: 'codex' },
  { title: 'Ship it', status: 'Done', tag: 'shipped' }
]

describe('visualizeMcpApply — buildVisualizedContent', () => {
  it('kanban: derives columns from distinct statuses (first-appearance) + binds cards', () => {
    const c = buildVisualizedContent('kanban', PLAN)
    expect(c.kind).toBe('kanban')
    expect(c.columns?.map((col) => col.id)).toEqual(['backlog', 'in-progress', 'done'])
    expect(c.cards).toHaveLength(4)
    expect(c.cards?.map((card) => card.columnId)).toEqual([
      'backlog',
      'in-progress',
      'in-progress',
      'done'
    ])
    // Card ids are minted + unique; chips ride through.
    expect(new Set(c.cards?.map((card) => card.id)).size).toBe(4)
    expect(c.cards?.[0]).toMatchObject({ title: 'Audit token flow', tag: 'research' })
    expect(c.size.w).toBeGreaterThanOrEqual(560)
  })

  it('kanban: no statuses anywhere → the default lanes, everything in the first', () => {
    const c = buildVisualizedContent('kanban', [{ title: 'a' }, { title: 'b' }])
    expect(c.columns?.map((col) => col.id)).toEqual(['backlog', 'in-progress', 'review', 'done'])
    expect(c.cards?.every((card) => card.columnId === 'backlog')).toBe(true)
  })

  it('grid: a planning board with one note element per item (no sections)', () => {
    const c = buildVisualizedContent('grid', PLAN)
    expect(c.kind).toBe('planning')
    expect(c.elements?.filter((e) => e.kind === 'note')).toHaveLength(4)
  })

  it('checklist: a planning board with ONE checklist; done-status rows are checked', () => {
    const c = buildVisualizedContent('checklist', PLAN)
    const lists = (c.elements ?? []).filter((e) => e.kind === 'checklist')
    expect(lists).toHaveLength(1)
    if (lists[0].kind !== 'checklist') throw new Error('expected a checklist')
    expect(lists[0].items.map((i) => i.done)).toEqual([false, false, false, true])
  })

  it('columns: one note per item (sectioned by status under the hood)', () => {
    const c = buildVisualizedContent('columns', PLAN)
    expect(c.elements?.filter((e) => e.kind === 'note')).toHaveLength(4)
  })

  it('throws on an empty plan and on a too-large plan', () => {
    expect(() => buildVisualizedContent('grid', [])).toThrow(/no items/)
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` }))
    expect(() => buildVisualizedContent('grid', tooMany)).toThrow(/cap exceeded/)
  })
})

describe('visualizeMcpApply — isVisualization', () => {
  it('accepts the four shapes and rejects anything else', () => {
    for (const v of ['kanban', 'grid', 'checklist', 'columns'])
      expect(isVisualization(v)).toBe(true)
    expect(isVisualization('bogus')).toBe(false)
    expect(isVisualization(undefined)).toBe(false)
    expect(isVisualization(3)).toBe(false)
  })
})

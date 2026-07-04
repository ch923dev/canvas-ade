import { describe, it, expect } from 'vitest'
import {
  buildBoardPlanning,
  createBoardPlanningMethod,
  type BoardPlanningInput
} from './mcpBoardPlanning'

/**
 * S6: the pure read projector for `canvas://board/{id}/planning` — turns one board's sanitized planning
 * mirror into the agent-facing element list (ids + editable fields), the READ half of the edit loop.
 */
const planningBoard: BoardPlanningInput = {
  id: 'p1',
  title: 'My plan',
  type: 'planning',
  planning: {
    elements: [
      { id: 'n1', kind: 'note', text: 'Phase 1', tint: 'yellow' },
      {
        id: 'c1',
        kind: 'checklist',
        title: 'Build progress',
        items: [
          { id: 'i1', label: 'read loop', done: true },
          { id: 'i2', label: 'write gate', done: false }
        ]
      },
      { id: 'd1', kind: 'diagram', source: 'graph TD\n A-->B' }
    ]
  }
}

describe('buildBoardPlanning — planning read projection', () => {
  it('projects every element with its id + editable fields', () => {
    const out = buildBoardPlanning(planningBoard)
    expect(out).toMatchObject({ boardId: 'p1', title: 'My plan', isPlanning: true })
    expect(out.elements).toHaveLength(3)
    expect(out.elements[0]).toEqual({ id: 'n1', kind: 'note', text: 'Phase 1', tint: 'yellow' })
    expect(out.elements[1]).toEqual({
      id: 'c1',
      kind: 'checklist',
      title: 'Build progress',
      items: [
        { id: 'i1', label: 'read loop', done: true },
        { id: 'i2', label: 'write gate', done: false }
      ]
    })
    expect(out.elements[2]).toEqual({ id: 'd1', kind: 'diagram', source: 'graph TD\n A-->B' })
  })

  it('omits an absent optional field (never emits undefined)', () => {
    const out = buildBoardPlanning({
      id: 'p2',
      title: 't',
      type: 'planning',
      planning: { elements: [{ id: 'a1', kind: 'arrow' }] }
    })
    expect(out.elements[0]).toEqual({ id: 'a1', kind: 'arrow' })
    expect('text' in out.elements[0]).toBe(false)
  })

  it('a non-planning board reads the graceful empty shell', () => {
    const out = buildBoardPlanning({ id: 't1', title: 'Term', type: 'terminal' })
    expect(out).toEqual({ boardId: 't1', title: 'Term', isPlanning: false, elements: [] })
  })

  it('a planning board with no projection reads the shell', () => {
    const out = buildBoardPlanning({ id: 'p3', title: 'empty', type: 'planning' })
    expect(out.isPlanning).toBe(false)
    expect(out.elements).toEqual([])
  })
})

describe('createBoardPlanningMethod — orchestrator loopback', () => {
  it('resolves the board from the live list and projects it', async () => {
    const { boardPlanning } = createBoardPlanningMethod(() => [planningBoard])
    const out = await boardPlanning('p1')
    expect(out.isPlanning).toBe(true)
    expect(out.elements[1]?.items).toHaveLength(2)
  })

  it('throws on an unknown board id (a wrong id is a genuine "no such board")', async () => {
    const { boardPlanning } = createBoardPlanningMethod(() => [planningBoard])
    await expect(boardPlanning('nope')).rejects.toThrow(/board not found/)
  })
})

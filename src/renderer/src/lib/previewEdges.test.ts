import { describe, it, expect } from 'vitest'
import { createBoard, type Board } from './boardSchema'
import { previewEdges } from './previewEdges'

const term = (id: string): Board => createBoard('terminal', { id, x: 0, y: 0 })
const linkedBrowser = (id: string, src?: string): Board => ({
  ...createBoard('browser', { id, x: 0, y: 0 }),
  ...(src ? { previewSourceId: src } : {})
})
const planning = (id: string): Board => createBoard('planning', { id, x: 0, y: 0 })

describe('previewEdges', () => {
  it('emits one edge per linked browser with a present source', () => {
    const boards = [term('t1'), linkedBrowser('b1', 't1'), linkedBrowser('b2')]
    expect(previewEdges(boards)).toEqual([
      { id: 'preview-b1', source: 't1', target: 'b1', type: 'preview', data: { stale: true } }
    ])
  })

  it('omits edges for a dangling source', () => {
    expect(previewEdges([linkedBrowser('b1', 'gone')])).toEqual([])
  })

  it('returns [] when nothing is linked', () => {
    expect(previewEdges([term('t1'), linkedBrowser('b1')])).toEqual([])
  })

  it('marks an edge stale when its source terminal is not running', () => {
    const boards = [
      { id: 't1', type: 'terminal' },
      { id: 'b1', type: 'browser', previewSourceId: 't1' }
    ] as never
    const live = previewEdges(boards, new Set(['t1']))
    expect(live[0].data?.stale).toBe(false)
    const down = previewEdges(boards, new Set())
    expect(down[0].data?.stale).toBe(true)
  })

  // BUG-022: previewSourceId pointing to a non-terminal board must NOT emit an edge
  it('does NOT emit an edge when previewSourceId points to a planning board (BUG-022)', () => {
    // planning board 'p1' exists in the set — ids.has('p1') is true — but it is NOT a terminal
    const boards: Board[] = [planning('p1'), linkedBrowser('b1', 'p1')]
    // Before the fix, previewEdges emits an edge here (wrong) and stale is permanently true
    expect(previewEdges(boards)).toEqual([])
  })

  it('does NOT emit an edge when previewSourceId points to another browser board (BUG-022)', () => {
    // browser board 'b2' exists in the set but is not a terminal
    const boards: Board[] = [linkedBrowser('b2'), linkedBrowser('b1', 'b2')]
    expect(previewEdges(boards)).toEqual([])
  })
})

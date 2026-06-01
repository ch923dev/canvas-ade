import { describe, it, expect } from 'vitest'
import { createBoard, type Board } from './boardSchema'
import { classifyPushTargets } from './previewTarget'

const term = (id: string, title = id): Board => ({
  ...createBoard('terminal', { id, x: 0, y: 0 }),
  title
})
const browser = (id: string, src?: string): Board => ({
  ...createBoard('browser', { id, x: 0, y: 0 }),
  ...(src ? { previewSourceId: src } : {})
})

describe('classifyPushTargets', () => {
  it('separates browsers linked to this terminal (A) from connectable ones (B, C)', () => {
    const boards = [
      term('t1'),
      term('t2', 'Term Two'),
      browser('A', 't1'), // connected to this terminal
      browser('B'), // unconnected
      browser('C', 't2') // connected to another terminal
    ]
    const { linkedIds, candidates } = classifyPushTargets(boards, 't1')
    expect(linkedIds).toEqual(['A'])
    expect(candidates.map((c) => c.id)).toEqual(['B', 'C'])
  })

  it('tags a connected-elsewhere browser (C) with the other terminal it would sever', () => {
    const boards = [term('t1'), term('t2', 'Term Two'), browser('C', 't2')]
    const { candidates } = classifyPushTargets(boards, 't1')
    expect(candidates[0].connectedTo).toEqual({ id: 't2', title: 'Term Two' })
  })

  it('leaves connectedTo undefined for an unconnected browser', () => {
    const { candidates } = classifyPushTargets([term('t1'), browser('B')], 't1')
    expect(candidates[0].connectedTo).toBeUndefined()
  })

  it('treats a dangling source id (no such terminal) as unconnected', () => {
    const { candidates } = classifyPushTargets([term('t1'), browser('X', 'ghost')], 't1')
    expect(candidates[0].connectedTo).toBeUndefined()
  })

  it('carries title + url so each choice can be labelled', () => {
    const { candidates } = classifyPushTargets([term('t1'), browser('B')], 't1')
    expect(candidates[0]).toMatchObject({
      id: 'B',
      title: expect.any(String),
      url: expect.any(String)
    })
  })

  it('returns no linked + no candidates when the terminal stands alone', () => {
    expect(classifyPushTargets([term('t1')], 't1')).toEqual({ linkedIds: [], candidates: [] })
  })
})

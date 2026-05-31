import { describe, it, expect } from 'vitest'
import { createBoard, type Board } from './boardSchema'
import { resolvePreviewTarget } from './previewTarget'

const term = (id: string): Board => createBoard('terminal', { id, x: 0, y: 0 })
const browser = (id: string, src?: string): Board => ({
  ...createBoard('browser', { id, x: 0, y: 0 }),
  ...(src ? { previewSourceId: src } : {})
})

describe('resolvePreviewTarget', () => {
  it('follows an existing link from the source terminal', () => {
    const boards = [term('t1'), browser('b1'), browser('b2', 't1')]
    expect(resolvePreviewTarget(boards, 'b1', 't1')).toEqual({ kind: 'existing', id: 'b2' })
  })

  it('uses the selected browser when no link exists', () => {
    const boards = [term('t1'), browser('b1'), browser('b2')]
    expect(resolvePreviewTarget(boards, 'b2', 't1')).toEqual({ kind: 'existing', id: 'b2' })
  })

  it('uses the sole browser when none selected', () => {
    const boards = [term('t1'), browser('b1')]
    expect(resolvePreviewTarget(boards, null, 't1')).toEqual({ kind: 'existing', id: 'b1' })
  })

  it('spawns when there are zero or multiple unselected browsers', () => {
    expect(resolvePreviewTarget([term('t1')], null, 't1')).toEqual({ kind: 'spawn' })
    const many = [term('t1'), browser('b1'), browser('b2')]
    expect(resolvePreviewTarget(many, null, 't1')).toEqual({ kind: 'spawn' })
  })
})

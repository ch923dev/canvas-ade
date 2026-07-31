import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../store/canvasStore'
import { useDockStore } from '../store/dockStore'
import { createBoard } from '../lib/boardSchema'
import type { TerminalBoard } from '../lib/boardSchema'
import { resolveFocusTarget } from './dockFocus'

describe('resolveFocusTarget (docked-terminal focus redirect, PR #416 review)', () => {
  beforeEach(() => {
    useDockStore.setState({ active: {} })
    const sw = createBoard('swarm', { id: 'sw1', x: 0, y: 0 })
    const docked = createBoard('terminal', { id: 'w1', x: 0, y: 0 }) as TerminalBoard
    docked.dockedIn = 'sw1'
    const free = createBoard('terminal', { id: 't1', x: 0, y: 0 })
    useCanvasStore.setState({
      boards: [sw, docked, free],
      connectors: [],
      groups: [],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
  })

  it('a docked worker resolves to its HOST swarm board and activates its dock tab', () => {
    expect(resolveFocusTarget('w1')).toBe('sw1')
    expect(useDockStore.getState().active['sw1']).toBe('w1')
  })

  it('a free terminal, a swarm board, and an unknown id pass through unchanged (no tab writes)', () => {
    expect(resolveFocusTarget('t1')).toBe('t1')
    expect(resolveFocusTarget('sw1')).toBe('sw1')
    expect(resolveFocusTarget('ghost')).toBe('ghost')
    expect(useDockStore.getState().active).toEqual({})
  })
})

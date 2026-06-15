import { describe, it, expect, beforeEach } from 'vitest'
import { useCommandStore } from './commandStore'

beforeEach(() => {
  // The store is a global singleton (one orchestrator face) — reset to defaults per test.
  useCommandStore.setState({ tasks: [], view: 'kanban', collapsed: false, expandedHeight: null })
})

describe('commandStore', () => {
  it('defaults to an empty kanban, expanded', () => {
    const s = useCommandStore.getState()
    expect(s.tasks).toEqual([])
    expect(s.view).toBe('kanban')
    expect(s.collapsed).toBe(false)
    expect(s.expandedHeight).toBeNull()
  })

  it('setView switches the seg selection', () => {
    useCommandStore.getState().setView('groups')
    expect(useCommandStore.getState().view).toBe('groups')
  })

  it('setCollapsed(true, h) collapses and remembers the expanded height', () => {
    useCommandStore.getState().setCollapsed(true, 440)
    expect(useCommandStore.getState().collapsed).toBe(true)
    expect(useCommandStore.getState().expandedHeight).toBe(440)
  })

  it('setCollapsed(false) keeps the remembered height for the next expand', () => {
    useCommandStore.getState().setCollapsed(true, 440)
    useCommandStore.getState().setCollapsed(false)
    expect(useCommandStore.getState().collapsed).toBe(false)
    expect(useCommandStore.getState().expandedHeight).toBe(440)
  })
})

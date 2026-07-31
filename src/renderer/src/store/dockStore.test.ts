import { describe, it, expect, beforeEach } from 'vitest'
import { useDockStore, activeDockTab } from './dockStore'

describe('dockStore (swarm docked-terminals — active tab per swarm board)', () => {
  beforeEach(() => {
    useDockStore.setState({ active: {} })
  })

  it('setActive records the tab per swarm board; activeDockTab reads it', () => {
    useDockStore.getState().setActive('sw-1', 'w-1')
    useDockStore.getState().setActive('sw-2', 'w-9')
    expect(activeDockTab('sw-1')).toBe('w-1')
    expect(activeDockTab('sw-2')).toBe('w-9')
    expect(activeDockTab('sw-3')).toBeUndefined() // rail default applies
  })

  it('setActive with the same value is a no-op (no new state ref → no subscriber churn)', () => {
    useDockStore.getState().setActive('sw-1', 'w-1')
    const before = useDockStore.getState().active
    useDockStore.getState().setActive('sw-1', 'w-1')
    expect(useDockStore.getState().active).toBe(before)
  })

  it('clear drops one swarm board without touching the others (and no-ops when absent)', () => {
    useDockStore.getState().setActive('sw-1', 'w-1')
    useDockStore.getState().setActive('sw-2', 'w-9')
    useDockStore.getState().clear('sw-1')
    expect(activeDockTab('sw-1')).toBeUndefined()
    expect(activeDockTab('sw-2')).toBe('w-9')
    const before = useDockStore.getState().active
    useDockStore.getState().clear('sw-ghost')
    expect(useDockStore.getState().active).toBe(before)
  })
})

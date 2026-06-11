// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWayfindingStore, MINIMAP_VISIBLE_KEY } from './wayfindingStore'

beforeEach(() => {
  window.localStorage.removeItem(MINIMAP_VISIBLE_KEY)
  useWayfindingStore.setState({ minimapVisible: false })
})

describe('wayfindingStore — minimap visibility (D4-C)', () => {
  it('toggleMinimap flips the state and persists it', () => {
    useWayfindingStore.getState().toggleMinimap()
    expect(useWayfindingStore.getState().minimapVisible).toBe(true)
    expect(window.localStorage.getItem(MINIMAP_VISIBLE_KEY)).toBe('1')
    useWayfindingStore.getState().toggleMinimap()
    expect(useWayfindingStore.getState().minimapVisible).toBe(false)
    expect(window.localStorage.getItem(MINIMAP_VISIBLE_KEY)).toBe('0')
  })

  it('setMinimapVisible identity-skips a same-value set (no notify, no re-write)', () => {
    const listener = vi.fn()
    const unsub = useWayfindingStore.subscribe(listener)
    useWayfindingStore.getState().setMinimapVisible(false) // already false
    expect(listener).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(MINIMAP_VISIBLE_KEY)).toBeNull()
    useWayfindingStore.getState().setMinimapVisible(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(MINIMAP_VISIBLE_KEY)).toBe('1')
    unsub()
  })

  it('initializes from the sticky key at store creation (toggled + remembered)', async () => {
    window.localStorage.setItem(MINIMAP_VISIBLE_KEY, '1')
    vi.resetModules()
    const fresh = await import('./wayfindingStore')
    expect(fresh.useWayfindingStore.getState().minimapVisible).toBe(true)
  })

  it('a failed sticky write degrades to in-session state (toggle still works)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    useWayfindingStore.getState().toggleMinimap()
    expect(useWayfindingStore.getState().minimapVisible).toBe(true)
    spy.mockRestore()
  })
})

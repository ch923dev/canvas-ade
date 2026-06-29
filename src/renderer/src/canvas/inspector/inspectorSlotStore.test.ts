import { beforeEach, describe, expect, it } from 'vitest'
import { useInspectorSlotStore } from './inspectorSlotStore'

describe('inspectorSlotStore — the shell↔board content-slot channel', () => {
  beforeEach(() => useInspectorSlotStore.setState({ slotEl: null, activeBoardId: null }))

  it('publishes the active board id', () => {
    useInspectorSlotStore.getState().setActiveBoardId('board-1')
    expect(useInspectorSlotStore.getState().activeBoardId).toBe('board-1')
    useInspectorSlotStore.getState().setActiveBoardId(null)
    expect(useInspectorSlotStore.getState().activeBoardId).toBeNull()
  })

  it('publishes the slot DOM node (and clears it on unmount)', () => {
    const el = { tagName: 'DIV' } as unknown as HTMLElement
    useInspectorSlotStore.getState().setSlotEl(el)
    expect(useInspectorSlotStore.getState().slotEl).toBe(el)
    useInspectorSlotStore.getState().setSlotEl(null)
    expect(useInspectorSlotStore.getState().slotEl).toBeNull()
  })
})

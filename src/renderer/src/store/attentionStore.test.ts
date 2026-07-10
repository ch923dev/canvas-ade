import { describe, it, expect, beforeEach } from 'vitest'
import { useAttentionStore } from './attentionStore'

describe('attentionStore', () => {
  beforeEach(() => {
    useAttentionStore.setState({ byId: {} })
  })

  it('marks a board and reads back', () => {
    useAttentionStore.getState().setAttention('b1', 'needs-input')
    expect(useAttentionStore.getState().byId).toEqual({ b1: 'needs-input' })
  })

  it('last-write-wins: a later event replaces the mark', () => {
    const s = useAttentionStore.getState()
    s.setAttention('b1', 'needs-input')
    s.setAttention('b1', 'done')
    expect(useAttentionStore.getState().byId.b1).toBe('done')
  })

  it('setting the same kind is a no-op (state identity unchanged)', () => {
    useAttentionStore.getState().setAttention('b1', 'error')
    const before = useAttentionStore.getState().byId
    useAttentionStore.getState().setAttention('b1', 'error')
    expect(useAttentionStore.getState().byId).toBe(before)
  })

  it('clear drops only the target board', () => {
    const s = useAttentionStore.getState()
    s.setAttention('b1', 'done')
    s.setAttention('b2', 'error')
    s.clearAttention('b1')
    expect(useAttentionStore.getState().byId).toEqual({ b2: 'error' })
  })

  it('clearing an unmarked board is a no-op (state identity unchanged)', () => {
    useAttentionStore.getState().setAttention('b1', 'done')
    const before = useAttentionStore.getState().byId
    useAttentionStore.getState().clearAttention('nope')
    expect(useAttentionStore.getState().byId).toBe(before)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { useSaveStatusStore } from './saveStatusStore'

beforeEach(() => useSaveStatusStore.getState().clearSaveFailure())

describe('saveStatusStore', () => {
  it('starts clean', () => {
    expect(useSaveStatusStore.getState().failure).toBeNull()
  })

  it('setSaveFailure records the message', () => {
    useSaveStatusStore.getState().setSaveFailure('disk full')
    expect(useSaveStatusStore.getState().failure).toBe('disk full')
  })

  it('a later failure replaces the message', () => {
    const s = useSaveStatusStore.getState()
    s.setSaveFailure('first')
    s.setSaveFailure('second')
    expect(useSaveStatusStore.getState().failure).toBe('second')
  })

  it('clearSaveFailure resets to clean', () => {
    const s = useSaveStatusStore.getState()
    s.setSaveFailure('disk full')
    s.clearSaveFailure()
    expect(useSaveStatusStore.getState().failure).toBeNull()
  })

  it('clearSaveFailure is a no-op ref-wise when already clean', () => {
    const before = useSaveStatusStore.getState()
    before.clearSaveFailure()
    expect(useSaveStatusStore.getState().failure).toBeNull()
  })
})

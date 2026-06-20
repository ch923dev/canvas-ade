import { describe, it, expect, beforeEach } from 'vitest'
import { useSaveStatusStore } from './saveStatusStore'

// Full reset (not just clearSaveFailure, which is a no-op when failure is already null and
// would leak a leftover 'saving'/'saved' state between cases).
beforeEach(() => useSaveStatusStore.setState({ state: 'idle', failure: null }))

describe('saveStatusStore', () => {
  it('starts clean (idle, no failure)', () => {
    expect(useSaveStatusStore.getState().failure).toBeNull()
    expect(useSaveStatusStore.getState().state).toBe('idle')
  })

  it('setSaveFailure records the message and moves to error', () => {
    useSaveStatusStore.getState().setSaveFailure('disk full')
    expect(useSaveStatusStore.getState().failure).toBe('disk full')
    expect(useSaveStatusStore.getState().state).toBe('error')
  })

  it('a later failure replaces the message', () => {
    const s = useSaveStatusStore.getState()
    s.setSaveFailure('first')
    s.setSaveFailure('second')
    expect(useSaveStatusStore.getState().failure).toBe('second')
  })

  it('clearSaveFailure resets to a clean idle', () => {
    const s = useSaveStatusStore.getState()
    s.setSaveFailure('disk full')
    s.clearSaveFailure()
    expect(useSaveStatusStore.getState().failure).toBeNull()
    expect(useSaveStatusStore.getState().state).toBe('idle')
  })

  it('clearSaveFailure is a no-op ref-wise when already clean', () => {
    const before = useSaveStatusStore.getState()
    before.clearSaveFailure()
    expect(useSaveStatusStore.getState().failure).toBeNull()
  })

  // PERSIST-03: the positive lifecycle.
  it('markSaving moves to saving', () => {
    useSaveStatusStore.getState().markSaving()
    expect(useSaveStatusStore.getState().state).toBe('saving')
  })

  it('markSaved moves to saved and clears any standing failure', () => {
    const s = useSaveStatusStore.getState()
    s.setSaveFailure('disk full')
    s.markSaved()
    expect(useSaveStatusStore.getState().state).toBe('saved')
    expect(useSaveStatusStore.getState().failure).toBeNull()
  })

  it('saving → saved is the normal success path', () => {
    const s = useSaveStatusStore.getState()
    s.markSaving()
    expect(useSaveStatusStore.getState().state).toBe('saving')
    s.markSaved()
    expect(useSaveStatusStore.getState().state).toBe('saved')
  })

  it('markSaving / markSaved are no-ops ref-wise when already in the target state', () => {
    const s = useSaveStatusStore.getState()
    s.markSaving()
    const savingRef = useSaveStatusStore.getState()
    s.markSaving()
    expect(useSaveStatusStore.getState()).toBe(savingRef)
    s.markSaved()
    const savedRef = useSaveStatusStore.getState()
    s.markSaved()
    expect(useSaveStatusStore.getState()).toBe(savedRef)
  })
})

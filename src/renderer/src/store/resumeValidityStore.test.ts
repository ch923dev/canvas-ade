/**
 * F1b: the palette-facing resume-verdict map. Pins the fail-closed default (missing entry
 * ⇒ undefined, consumers coalesce to false), publish/overwrite, and the removal GC — a
 * stale `true` for a deleted board must not linger.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useResumeValidityStore } from './resumeValidityStore'

beforeEach(() => useResumeValidityStore.setState({ validity: {} }))

describe('resumeValidityStore', () => {
  it('defaults to no entry — the consumer side stays fail-closed', () => {
    expect(useResumeValidityStore.getState().validity['t1']).toBeUndefined()
  })

  it('publishes and overwrites per board id', () => {
    const s = useResumeValidityStore.getState()
    s.setResumeValidity('t1', true)
    s.setResumeValidity('t2', false)
    expect(useResumeValidityStore.getState().validity).toEqual({ t1: true, t2: false })
    s.setResumeValidity('t1', false)
    expect(useResumeValidityStore.getState().validity['t1']).toBe(false)
  })

  it('same-value publish is a no-op (no subscriber churn)', () => {
    useResumeValidityStore.getState().setResumeValidity('t1', true)
    const before = useResumeValidityStore.getState()
    useResumeValidityStore.getState().setResumeValidity('t1', true)
    expect(useResumeValidityStore.getState()).toBe(before)
  })

  it('clear removes the entry entirely; clearing an absent id is a no-op', () => {
    useResumeValidityStore.getState().setResumeValidity('t1', true)
    useResumeValidityStore.getState().clearResumeValidity('t1')
    expect('t1' in useResumeValidityStore.getState().validity).toBe(false)
    const before = useResumeValidityStore.getState()
    useResumeValidityStore.getState().clearResumeValidity('ghost')
    expect(useResumeValidityStore.getState()).toBe(before)
  })
})

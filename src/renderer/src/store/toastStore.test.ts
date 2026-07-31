import { describe, it, expect, beforeEach } from 'vitest'
import {
  useToastStore,
  showToast,
  dismissToast,
  selectVisibleToasts,
  evictExcessSticky,
  MAX_STICKY,
  type Toast
} from './toastStore'

beforeEach(() => {
  useToastStore.getState().clearToasts()
})

describe('toastStore — queue semantics', () => {
  it('showToast appends in FIFO order and returns a unique id per toast', () => {
    const a = showToast({ message: 'first' })
    const b = showToast({ message: 'second' })
    expect(a).not.toBe(b)
    const { toasts } = useToastStore.getState()
    expect(toasts.map((t) => t.message)).toEqual(['first', 'second'])
  })

  it('defaults kind to info and sticky to false', () => {
    showToast({ message: 'm' })
    const [t] = useToastStore.getState().toasts
    expect(t.kind).toBe('info')
    expect(t.sticky).toBe(false)
  })

  it('carries kind, sticky, and action through to the stored toast', () => {
    const run = (): void => {}
    showToast({
      message: 'save failed',
      kind: 'error',
      sticky: true,
      action: { label: 'Retry', run }
    })
    const [t] = useToastStore.getState().toasts
    expect(t.kind).toBe('error')
    expect(t.sticky).toBe(true)
    expect(t.action?.label).toBe('Retry')
    expect(t.action?.run).toBe(run)
  })

  it('replaces a keyed toast in place (same id) instead of appending', () => {
    showToast({ message: 'other' })
    showToast({ id: 'save-failure', message: 'failed once', kind: 'error' })
    showToast({ message: 'later' })
    showToast({ id: 'save-failure', message: 'failed again', kind: 'error' })
    const msgs = useToastStore.getState().toasts.map((t) => t.message)
    // Position preserved: the keyed toast stays where it first landed.
    expect(msgs).toEqual(['other', 'failed again', 'later'])
  })

  it('dismissToast removes only the matching id', () => {
    const a = showToast({ message: 'a' })
    showToast({ message: 'b' })
    dismissToast(a)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['b'])
  })

  it('dismissToast on an absent id does not churn state (same reference)', () => {
    showToast({ message: 'a' })
    const before = useToastStore.getState().toasts
    dismissToast('nope')
    expect(useToastStore.getState().toasts).toBe(before)
  })

  it('clearToasts empties the queue', () => {
    showToast({ message: 'a' })
    showToast({ message: 'b' })
    useToastStore.getState().clearToasts()
    expect(useToastStore.getState().toasts).toEqual([])
  })
})

const mk = (id: string, sticky: boolean): Toast => ({
  id,
  message: id,
  kind: 'info',
  sticky
})

describe('selectVisibleToasts — sticky-slot fairness (audit P1-2b)', () => {
  it('short queues pass through untouched (same reference)', () => {
    const list = [mk('a', true), mk('b', true), mk('c', true)]
    expect(selectVisibleToasts(list, { max: 3, maxSticky: 2 })).toBe(list)
  })

  it('a transient stays reachable behind 3+ queued sticky toasts — the starvation case', () => {
    const list = [mk('s1', true), mk('s2', true), mk('s3', true), mk('t1', false)]
    const visible = selectVisibleToasts(list, { max: 3, maxSticky: 2 })
    expect(visible.map((t) => t.id)).toEqual(['s1', 's2', 't1'])
  })

  it('never shows more than maxSticky sticky while any transient waits', () => {
    const list = [mk('s1', true), mk('s2', true), mk('s3', true), mk('t1', false), mk('t2', false)]
    const visible = selectVisibleToasts(list, { max: 3, maxSticky: 2 })
    expect(visible.filter((t) => t.sticky)).toHaveLength(2)
    expect(visible.map((t) => t.id)).toEqual(['s1', 's2', 't1'])
  })

  it('leftover slots fall back to the oldest remaining sticky when no transient waits', () => {
    const list = [mk('s1', true), mk('s2', true), mk('s3', true), mk('s4', true)]
    const visible = selectVisibleToasts(list, { max: 3, maxSticky: 2 })
    expect(visible.map((t) => t.id)).toEqual(['s1', 's2', 's3'])
  })

  it('preserves queue order (oldest first) in the result', () => {
    const list = [mk('t1', false), mk('s1', true), mk('t2', false), mk('s2', true), mk('t3', false)]
    const visible = selectVisibleToasts(list, { max: 3, maxSticky: 2 })
    expect(visible.map((t) => t.id)).toEqual(['t1', 's1', 't2'])
  })
})

describe('sticky retention backstop (audit P1-2c)', () => {
  it('evictExcessSticky drops the OLDEST sticky only, never a transient', () => {
    const list = [mk('s1', true), mk('t1', false), mk('s2', true), mk('s3', true)]
    const out = evictExcessSticky(list, 2)
    expect(out.map((t) => t.id)).toEqual(['t1', 's2', 's3'])
  })

  it('under the cap returns the SAME array (no churn)', () => {
    const list = [mk('s1', true), mk('t1', false)]
    expect(evictExcessSticky(list, 2)).toBe(list)
  })

  it('showToast engages the cap: sticky #MAX_STICKY+1 evicts the oldest sticky', () => {
    for (let i = 0; i < MAX_STICKY + 1; i++) {
      showToast({ id: `s${i}`, message: `s${i}`, sticky: true })
    }
    const ids = useToastStore.getState().toasts.map((t) => t.id)
    expect(ids).toHaveLength(MAX_STICKY)
    expect(ids[0]).toBe('s1') // s0 (oldest sticky) evicted
  })
})

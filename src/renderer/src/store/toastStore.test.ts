import { describe, it, expect, beforeEach } from 'vitest'
import { useToastStore, showToast, dismissToast } from './toastStore'

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

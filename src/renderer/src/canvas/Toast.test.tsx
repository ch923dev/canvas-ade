// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { ToastIsland, TOAST_AUTO_DISMISS_MS } from './Toast'
import { useToastStore, showToast } from '../store/toastStore'

beforeEach(() => {
  vi.useFakeTimers()
  useToastStore.getState().clearToasts()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const island = (): HTMLElement | null => document.querySelector('[data-test=toast-island]')
const items = (): HTMLElement[] => Array.from(document.querySelectorAll('.toast-item'))

describe('ToastIsland — render + queue', () => {
  it('renders nothing while the queue is empty', () => {
    render(<ToastIsland />)
    expect(island()).toBeNull()
  })

  it('renders queued toasts oldest-first, capped at 3 visible', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'one' })
      showToast({ message: 'two' })
      showToast({ message: 'three' })
      showToast({ message: 'four' })
    })
    const texts = items().map((el) => el.textContent)
    expect(items()).toHaveLength(3)
    expect(texts[0]).toContain('one')
    expect(texts[2]).toContain('three')
  })

  it('uses role="status" for info/ok and role="alert" for errors', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'saved', kind: 'ok' })
      showToast({ message: 'broke', kind: 'error' })
    })
    const [ok, err] = items()
    expect(ok.getAttribute('role')).toBe('status')
    expect(err.getAttribute('role')).toBe('alert')
  })

  it('marks each toast with its kind for the status dot', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'broke', kind: 'error' })
    })
    expect(items()[0].dataset.kind).toBe('error')
  })
})

describe('ToastIsland — dismissal', () => {
  it('the ✕ button dismisses its toast', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'bye' })
    })
    fireEvent.click(items()[0].querySelector('[aria-label="Dismiss"]') as HTMLElement)
    expect(island()).toBeNull()
  })

  it('auto-dismisses a non-sticky toast after the timeout', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'transient' })
    })
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 50)
    })
    expect(island()).toBeNull()
  })

  it('never auto-dismisses a sticky toast', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'save failed', kind: 'error', sticky: true })
    })
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 4)
    })
    expect(items()).toHaveLength(1)
  })

  it('a queued 4th toast becomes visible when a slot frees, with its own full timeout', () => {
    render(<ToastIsland />)
    act(() => {
      showToast({ message: 'one' })
      showToast({ message: 'two' })
      showToast({ message: 'three' })
      showToast({ message: 'four' })
    })
    // All three visible expire; 'four' surfaces and must NOT expire with them
    // (its timer starts at visibility, not enqueue).
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 50)
    })
    expect(items().map((el) => el.textContent?.includes('four'))).toEqual([true])
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 50)
    })
    expect(island()).toBeNull()
  })
})

describe('ToastIsland — action button', () => {
  it('renders the action label and runs it on click', () => {
    const run = vi.fn()
    render(<ToastIsland />)
    act(() => {
      showToast({
        message: 'save failed',
        kind: 'error',
        sticky: true,
        action: { label: 'Retry', run }
      })
    })
    const btn = items()[0].querySelector('.toast-action') as HTMLElement
    expect(btn.textContent).toBe('Retry')
    fireEvent.click(btn)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

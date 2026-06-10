// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { ProjectSwitcher } from './AppChrome'
import { useSaveStatusStore } from '../store/saveStatusStore'
import { useToastStore } from '../store/toastStore'

// D1-A: the D0-8 save-failure chip is gone — ProjectSwitcher bridges the
// saveStatusStore failure into a STICKY error toast with a Retry action instead.

let save: ReturnType<typeof vi.fn>

beforeEach(() => {
  save = vi.fn(async () => true)
  ;(window as unknown as { api: unknown }).api = {
    project: { recents: vi.fn().mockResolvedValue([]), save }
  }
  useSaveStatusStore.getState().clearSaveFailure()
  useToastStore.getState().clearToasts()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const failureToast = (): ReturnType<typeof useToastStore.getState>['toasts'][number] | undefined =>
  useToastStore.getState().toasts.find((t) => t.id === 'save-failure')

describe('ProjectSwitcher — save failure routes to a sticky toast (D1-A, replaces the D0-8 chip)', () => {
  it('a published failure raises a sticky error toast with a Retry action (no chip)', async () => {
    render(<ProjectSwitcher />)
    act(() => {
      useSaveStatusStore.getState().setSaveFailure('Could not save project — disk full')
    })
    await waitFor(() => expect(failureToast()).toBeTruthy())
    const t = failureToast()
    expect(t?.kind).toBe('error')
    expect(t?.sticky).toBe(true)
    expect(t?.message).toBe('Could not save project — disk full')
    expect(t?.action?.label).toBe('Retry')
    expect(document.querySelector('.proj-save-chip')).toBeNull()
  })

  it('a successful Retry clears the failure and dismisses the toast', async () => {
    render(<ProjectSwitcher />)
    act(() => {
      useSaveStatusStore.getState().setSaveFailure('Could not save project')
    })
    await waitFor(() => expect(failureToast()).toBeTruthy())
    await act(async () => {
      failureToast()?.action?.run()
    })
    expect(save).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(useSaveStatusStore.getState().failure).toBeNull()
      expect(failureToast()).toBeUndefined()
    })
  })

  it('a failed Retry (save returns false) refreshes the toast message in place', async () => {
    save.mockResolvedValue(false)
    render(<ProjectSwitcher />)
    act(() => {
      useSaveStatusStore.getState().setSaveFailure('Could not save project')
    })
    await waitFor(() => expect(failureToast()).toBeTruthy())
    await act(async () => {
      failureToast()?.action?.run()
    })
    await waitFor(() =>
      expect(failureToast()?.message).toBe('Save failed again — check disk space and permissions')
    )
    // Still exactly one keyed toast — replaced, not stacked.
    expect(useToastStore.getState().toasts.filter((t) => t.id === 'save-failure')).toHaveLength(1)
  })

  it('clearing the failure externally (next successful autosave) dismisses the toast', async () => {
    render(<ProjectSwitcher />)
    act(() => {
      useSaveStatusStore.getState().setSaveFailure('Could not save project')
    })
    await waitFor(() => expect(failureToast()).toBeTruthy())
    act(() => {
      useSaveStatusStore.getState().clearSaveFailure()
    })
    await waitFor(() => expect(failureToast()).toBeUndefined())
  })
})

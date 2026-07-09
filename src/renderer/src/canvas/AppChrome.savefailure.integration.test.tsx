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
  save = vi.fn(async () => ({ ok: true })) // C3: project.save now returns { ok, code? }
  ;(window as unknown as { api: unknown }).api = {
    project: { recents: vi.fn().mockResolvedValue([]), save }
  }
  // Full reset (clearSaveFailure is a no-op when failure is already null, which would
  // leak a leftover 'saving'/'saved' lifecycle state between the PERSIST-03 cases below).
  useSaveStatusStore.setState({ state: 'idle', failure: null })
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

  it('a failed Retry (save returns { ok:false }) refreshes the toast message in place', async () => {
    save.mockResolvedValue({ ok: false, code: 'ENOSPC' }) // C3: a real disk-full errno
    render(<ProjectSwitcher />)
    act(() => {
      useSaveStatusStore.getState().setSaveFailure('Could not save project')
    })
    await waitFor(() => expect(failureToast()).toBeTruthy())
    await act(async () => {
      failureToast()?.action?.run()
    })
    await waitFor(() =>
      expect(failureToast()?.message).toBe('Save failed again — the disk is full.')
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

// PERSIST-03: the ambient save-status indicator (role=status) next to the board count.
describe('ProjectSwitcher — ambient save status (PERSIST-03)', () => {
  const statusEl = (): HTMLElement | null => document.querySelector('[role="status"]')

  it('reads "Saved" at rest (idle — a freshly-opened project is already on disk)', () => {
    render(<ProjectSwitcher />)
    expect(statusEl()?.textContent).toContain('Saved')
  })

  it('shows "Saving…" during a write, then "Saved" on success', () => {
    render(<ProjectSwitcher />)
    act(() => useSaveStatusStore.getState().markSaving())
    expect(statusEl()?.textContent).toContain('Saving')
    act(() => useSaveStatusStore.getState().markSaved())
    expect(statusEl()?.textContent).toContain('Saved')
  })

  it('shows "Save failed" on error (alongside the sticky Retry toast)', () => {
    render(<ProjectSwitcher />)
    act(() => useSaveStatusStore.getState().setSaveFailure('disk full'))
    expect(statusEl()?.textContent).toContain('Save failed')
  })
})

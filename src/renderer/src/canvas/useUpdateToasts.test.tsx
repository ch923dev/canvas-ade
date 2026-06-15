import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUpdateToasts } from './useUpdateToasts'
import { useToastStore } from '../store/toastStore'

type Status = { state: string; version?: string; percent?: number; message?: string }

let emit: (s: Status) => void = () => {}
const install = vi.fn()

beforeEach(() => {
  useToastStore.getState().clearToasts()
  install.mockClear()
  emit = () => {}
  ;(window as unknown as { api: unknown }).api = {
    update: {
      onStatus: (l: (s: Status) => void) => {
        emit = l
        return () => {}
      },
      install
    }
  }
})

const toasts = (): ReturnType<typeof useToastStore.getState>['toasts'] =>
  useToastStore.getState().toasts

describe('useUpdateToasts', () => {
  it('shows a keyed sticky toast while downloading (updates in place)', () => {
    renderHook(() => useUpdateToasts())
    act(() => emit({ state: 'available', version: '1.2.3' }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].id).toBe('app-update')
    expect(toasts()[0].sticky).toBe(true)
    expect(toasts()[0].message).toContain('1.2.3')

    act(() => emit({ state: 'downloading', percent: 42 }))
    // Same keyed id → replaced in place, not a second toast.
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toContain('42%')
  })

  it('offers a Restart action when ready that calls update.install', () => {
    renderHook(() => useUpdateToasts())
    act(() => emit({ state: 'ready', version: '2.0.0' }))
    const t = toasts()[0]
    expect(t.kind).toBe('ok')
    expect(t.action?.label).toBe('Restart')
    act(() => t.action?.run())
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('clears the toast on a background error (no nag)', () => {
    renderHook(() => useUpdateToasts())
    act(() => emit({ state: 'available', version: '3.0.0' }))
    expect(toasts()).toHaveLength(1)
    act(() => emit({ state: 'error', message: 'feed unreachable' }))
    expect(toasts()).toHaveLength(0)
  })

  it('is inert when window.api.update is absent (older preload)', () => {
    ;(window as unknown as { api: unknown }).api = {}
    expect(() => renderHook(() => useUpdateToasts())).not.toThrow()
    expect(toasts()).toHaveLength(0)
  })
})

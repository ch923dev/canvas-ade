// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useAutosave } from './useAutosave'
import { useCanvasStore } from './canvasStore'
import { useSaveStatusStore } from './saveStatusStore'

// D1-A follow-up: a dir-less "open" project (the e2e harness boot; production always
// opens with a dir) has nowhere to save to — the autosave gate must stay CLOSED instead
// of attempting a write MAIN fails, which raised a phantom sticky save-failure toast
// over every e2e run (caught by preview-align.e2e: the toast island's occlusion zone
// demoted the board under it).

let save: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  save = vi.fn(async () => true)
  ;(window as unknown as { api: unknown }).api = {
    project: { save, onFlush: vi.fn(() => () => {}) }
  }
  useSaveStatusStore.getState().clearSaveFailure()
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    background: null,
    selectedId: null,
    past: [],
    future: []
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('useAutosave — dir-less project gate', () => {
  it('does NOT attempt a save (or raise a failure) while project.dir is null', () => {
    useCanvasStore.setState({ project: { dir: null, name: 'e2e', status: 'open' } })
    renderHook(() => useAutosave())
    act(() => {
      useCanvasStore.getState().addBoard('planning', { x: 100, y: 100 })
    })
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(save).not.toHaveBeenCalled()
    expect(useSaveStatusStore.getState().failure).toBeNull()
  })

  it('still saves normally when the open project has a dir', async () => {
    useCanvasStore.setState({ project: { dir: 'C:/p', name: 'p', status: 'open' } })
    renderHook(() => useAutosave())
    act(() => {
      useCanvasStore.getState().addBoard('planning', { x: 100, y: 100 })
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(save).toHaveBeenCalledTimes(1)
  })
})

// Settings-class persisted state (groups v6, background v9) round-trips through
// toObject but rode its OWN store ref — a change to it leaves boards/connectors/viewport
// untouched. The subscription must watch those refs too, or a backdrop pick / group
// rename with no board or camera edit before the next flush silently fails to persist.
// These prove the wiring (subscription → schedule → save) the pure hasSavableChange
// unit tests cannot — they were the untested gap that hid the bug.
describe('useAutosave — settings-class persistence triggers', () => {
  it('a backdrop-only change autosaves with no board/camera edit (v9 regression)', async () => {
    useCanvasStore.setState({ project: { dir: 'C:/p', name: 'p', status: 'open' } })
    renderHook(() => useAutosave())
    act(() => {
      useCanvasStore.getState().setBackground({ kind: 'scene', scene: 'blossom-river' })
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a group-only change autosaves with no board/camera edit (v6 regression)', async () => {
    useCanvasStore.setState({ project: { dir: 'C:/p', name: 'p', status: 'open' } })
    renderHook(() => useAutosave())
    act(() => {
      useCanvasStore.getState().addGroup('Group A', [])
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(save).toHaveBeenCalledTimes(1)
  })
})

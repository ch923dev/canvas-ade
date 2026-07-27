// @vitest-environment jsdom
/**
 * `useResidentProjects` — the one resident list (audit R10).
 *
 * Two properties are worth pinning, and they are the two the duplicated `useState` copies got
 * wrong:
 *   • LIVENESS. Neither old copy subscribed to `project:bgLifecycle`, so MAIN closing a resident
 *     on its idle sweep left an open dock/menu rendering a project that no longer exists — with a
 *     ✕ that acts on a dead registry entry. Nothing in the UI ever showed this; it just went stale.
 *   • SHARING. Two surfaces must be one listener and one fetch. Getting this wrong is invisible in
 *     behaviour (both copies would still be correct) and shows up only as duplicated IPC and a
 *     listener that outlives its last consumer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { ReactElement } from 'react'
import {
  useResidentProjects,
  useResidentProjectsStore,
  resetResidentProjectsSubscription
} from './useResidentProjects'

const listBackground = vi.fn(async () => [
  { dir: 'C:/a', name: 'a', terminalsRunning: 1, previews: 0, backgroundedAt: 1 }
])
const keepForeverDirs = vi.fn(async () => ['C:/a'])
const unsubscribe = vi.fn()
/** The renderer's bgLifecycle listener, captured so a test can play MAIN's push. */
let pushLifecycle: (() => void) | null = null
const onBgLifecycle = vi.fn((handler: () => void) => {
  pushLifecycle = handler
  return unsubscribe
})

function Consumer(): ReactElement {
  const { bg, forever } = useResidentProjects()
  return <div data-testid="out">{`${bg.map((b) => b.dir).join(',')}|${forever.join(',')}`}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  pushLifecycle = null
  resetResidentProjectsSubscription()
  useResidentProjectsStore.setState({ bg: [], forever: [] })
  ;(globalThis as unknown as { window: Window & { api: unknown } }).window.api = {
    project: { listBackground, keepForeverDirs, onBgLifecycle }
  } as never
})

afterEach(() => {
  cleanup()
  resetResidentProjectsSubscription()
})

describe('useResidentProjects', () => {
  it('fetches on mount and renders both halves', async () => {
    const { findByTestId } = render(<Consumer />)

    expect((await findByTestId('out')).textContent).toBe('C:/a|C:/a')
  })

  it('re-fetches when MAIN reports a background-lifecycle change', async () => {
    render(<Consumer />)
    await act(async () => {})
    expect(listBackground).toHaveBeenCalledTimes(1)

    // MAIN's idle sweep closed or evicted a resident. The surface must not keep rendering it.
    listBackground.mockResolvedValueOnce([])
    await act(async () => {
      pushLifecycle?.()
    })

    expect(listBackground).toHaveBeenCalledTimes(2)
    expect(useResidentProjectsStore.getState().bg).toEqual([])
  })

  it('two mounted surfaces share ONE listener', async () => {
    render(
      <>
        <Consumer />
        <Consumer />
      </>
    )
    await act(async () => {})

    expect(onBgLifecycle).toHaveBeenCalledTimes(1)
  })

  it('concurrent refreshes collapse into one pair of IPC reads', async () => {
    const { refresh } = useResidentProjectsStore.getState()

    await act(async () => {
      await Promise.all([refresh(), refresh(), refresh()])
    })

    expect(listBackground).toHaveBeenCalledTimes(1)
    expect(keepForeverDirs).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes only when the LAST consumer unmounts', async () => {
    const a = render(<Consumer />)
    const b = render(<Consumer />)
    await act(async () => {})

    a.unmount()
    expect(unsubscribe).not.toHaveBeenCalled()

    b.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('degrades to an empty list when the channel is absent (partial api mock)', async () => {
    ;(globalThis as unknown as { window: Window & { api: unknown } }).window.api = {
      project: {}
    } as never

    const { findByTestId } = render(<Consumer />)

    expect((await findByTestId('out')).textContent).toBe('|')
  })
})

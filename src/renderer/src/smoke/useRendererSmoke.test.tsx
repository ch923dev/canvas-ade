import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRendererSmoke } from './useRendererSmoke'

/**
 * BUG-056: the Phase-0 renderer smoke probe must stay inert on a normal launch and
 * only run when MAIN loaded the page with `?smoke=1` (set only under CANVAS_SMOKE).
 */
describe('useRendererSmoke', () => {
  const originalSearch = window.location.search

  afterEach(() => {
    window.history.replaceState(null, '', `${window.location.pathname}${originalSearch}`)
    vi.restoreAllMocks()
  })

  it('does not run the probe outside the smoke harness', async () => {
    window.history.replaceState(null, '', window.location.pathname)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    renderHook(() => useRendererSmoke())
    // Flush any microtasks the (skipped) probe would have queued.
    await Promise.resolve()

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('RENDERER_SMOKE'))
  })

  it('runs the probe when the page was loaded with ?smoke=1', async () => {
    window.history.replaceState(null, '', `${window.location.pathname}?smoke=1`)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    renderHook(() => useRendererSmoke())

    // The probe awaits dynamic imports before logging; poll until it settles.
    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RENDERER_SMOKE'))
    })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the canvas store so disposeLiveResources runs against a fixed board list.
const { storeState } = vi.hoisted(() => ({
  storeState: { boards: [] as Array<{ id: string; type: string }> }
}))
vi.mock('./canvasStore', () => ({
  useCanvasStore: { getState: () => storeState }
}))

import { disposeLiveResources } from './disposeLiveResources'

const closeAllPreviews = vi.fn<() => Promise<boolean>>()
const closeAllOsr = vi.fn<() => Promise<boolean>>()
const disposeAllTerminals = vi.fn<() => Promise<boolean>>()

describe('disposeLiveResources (PTY-1)', () => {
  beforeEach(() => {
    storeState.boards = [{ id: 't1', type: 'terminal' }]
    closeAllPreviews.mockReset().mockResolvedValue(true)
    closeAllOsr.mockReset().mockResolvedValue(true)
    disposeAllTerminals.mockReset().mockResolvedValue(true)
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { closeAllPreviews, closeAllOsr, disposeAllTerminals }
    }
  })

  it('drains ALL terminal sessions (live + parked) via disposeAllTerminals on switch', async () => {
    await disposeLiveResources()
    // disposeAllTerminals reaps BOTH the live and parked maps in main — the per-board
    // killTerminal loop missed parked/deleted-but-undoable sessions (parked-PTY leak).
    expect(disposeAllTerminals).toHaveBeenCalledTimes(1)
  })

  it('still closes all preview views', async () => {
    await disposeLiveResources()
    expect(closeAllPreviews).toHaveBeenCalledTimes(1)
  })

  it('closes all OSR offscreen windows too (OS-3 Phase 5 — deterministic reset sweep)', async () => {
    await disposeLiveResources()
    expect(closeAllOsr).toHaveBeenCalledTimes(1)
  })

  it('swallows IPC failures (best-effort) without throwing', async () => {
    disposeAllTerminals.mockRejectedValue(new Error('ipc down'))
    await expect(disposeLiveResources()).resolves.toBeUndefined()
  })
})

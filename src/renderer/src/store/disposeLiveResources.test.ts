import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the canvas store so disposeLiveResources runs against a fixed board list.
const { storeState } = vi.hoisted(() => ({
  storeState: { boards: [] as Array<{ id: string; type: string }> }
}))
vi.mock('./canvasStore', () => ({
  useCanvasStore: { getState: () => storeState }
}))

import { disposeLiveResources, backgroundLiveResources } from './disposeLiveResources'

const closeAllOsr = vi.fn<() => Promise<boolean>>()
const disposeAllTerminals = vi.fn<() => Promise<boolean>>()

describe('disposeLiveResources (PTY-1)', () => {
  beforeEach(() => {
    storeState.boards = [{ id: 't1', type: 'terminal' }]
    closeAllOsr.mockReset().mockResolvedValue(true)
    disposeAllTerminals.mockReset().mockResolvedValue(true)
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { closeAllOsr, disposeAllTerminals }
    }
  })

  it('drains ALL terminal sessions (live + parked) via disposeAllTerminals on switch', async () => {
    await disposeLiveResources()
    // disposeAllTerminals reaps BOTH the live and parked maps in main — the per-board
    // killTerminal loop missed parked/deleted-but-undoable sessions (parked-PTY leak).
    expect(disposeAllTerminals).toHaveBeenCalledTimes(1)
  })

  it('closes all OSR offscreen windows (deterministic reset sweep)', async () => {
    await disposeLiveResources()
    expect(closeAllOsr).toHaveBeenCalledTimes(1)
  })

  it('swallows IPC failures (best-effort) without throwing', async () => {
    disposeAllTerminals.mockRejectedValue(new Error('ipc down'))
    await expect(disposeLiveResources()).resolves.toBeUndefined()
  })
})

// Review fix: the keep-handover must report its outcome — a swallowed project:background
// failure let the switch proceed to the unmount, whose cleanups then KILLED the never-parked
// sessions the user chose to keep. performProjectSwitch aborts on false (save-failed pattern).
describe('backgroundLiveResources (honest handover outcome)', () => {
  const setApi = (project: unknown): void => {
    ;(globalThis as unknown as { window: unknown }).window = { api: { project } }
  }

  it('true when MAIN confirms the background registration', async () => {
    setApi({ background: vi.fn().mockResolvedValue({ ok: true, terminals: 1, previews: 0 }) })
    await expect(backgroundLiveResources('C:/proj/A')).resolves.toBe(true)
  })

  it('false when the handler reports ok:false (e.g. no current dir)', async () => {
    setApi({ background: vi.fn().mockResolvedValue({ ok: false, terminals: 0, previews: 0 }) })
    await expect(backgroundLiveResources('C:/proj/A')).resolves.toBe(false)
  })

  it('false when the IPC rejects, and false (not a throw) on a partial window.api mock', async () => {
    setApi({ background: vi.fn().mockRejectedValue(new Error('ipc down')) })
    await expect(backgroundLiveResources('C:/proj/A')).resolves.toBe(false)
    setApi({}) // no background method at all — must degrade, never throw
    await expect(backgroundLiveResources('C:/proj/A')).resolves.toBe(false)
  })
})

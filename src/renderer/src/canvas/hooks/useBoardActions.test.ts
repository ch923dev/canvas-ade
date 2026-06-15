// @vitest-environment jsdom
/**
 * #BUG-015 — `remove()` parks a terminal board's live session via
 * `window.api.parkTerminal(id)` before removal. That invoke (`pty:park`) rejects on a
 * teardown/channel-gone race (closing window / main reload). The renderer has no global
 * `unhandledrejection` handler in production, so an un-`.catch()`ed reject surfaces as an
 * unhandled promise. The fix adds a `.catch()` mirroring Canvas.tsx's memory.* guards.
 *
 * This drives the REAL `remove` closure (the same object handed to every BoardNode) against a
 * REAL terminal board in the store with a rejecting `parkTerminal` — it does NOT fake the
 * park call, so dropping the `.catch()` makes the test fail (an unhandledrejection fires).
 *
 * globals: false — import all vitest helpers explicitly (see vitest.config.ts).
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useBoardActions, type BoardActionsDeps } from './useBoardActions'
import { useCanvasStore } from '../../store/canvasStore'

const park = vi.fn<(id: string) => Promise<boolean>>()

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the singleton store (mirrors Canvas.pushundo.test.ts) and seed via the real addBoard.
  useCanvasStore.setState({ boards: [], connectors: [], past: [], future: [] })
  ;(window as unknown as { api: { parkTerminal: typeof park } }).api = { parkTerminal: park }
})

/** Stub deps: every callback is a no-op vi.fn(); the refs are real (remove() reads .current). */
function makeDeps(): BoardActionsDeps {
  return {
    duplicateBoard: vi.fn(() => null),
    removeBoard: vi.fn(),
    openFullView: vi.fn(),
    closeFullView: vi.fn(),
    hardCloseFullView: vi.fn(),
    enterCameraFullView: vi.fn(),
    exitCameraFullView: vi.fn(),
    fullViewIdRef: { current: null },
    cameraFullViewIdRef: { current: null },
    reflowAddToGroup: vi.fn(),
    removeBoardFromAllGroups: vi.fn(),
    setFocusedId: vi.fn(),
    setSelectedConnectorId: vi.fn(),
    setConnectPointer: vi.fn(),
    setConnectFromId: vi.fn()
  }
}

describe('#BUG-015 — useBoardActions.remove guards the parkTerminal rejection', () => {
  let unhandled: ReturnType<typeof vi.fn>
  beforeEach(() => {
    unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled as EventListener)
  })
  afterEach(() => {
    window.removeEventListener('unhandledrejection', unhandled as EventListener)
  })

  it('a rejected parkTerminal does not surface as an unhandledRejection', async () => {
    park.mockRejectedValue(new Error('IPC channel gone'))
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const { result } = renderHook(() => useBoardActions(makeDeps()))

    // Drives the REAL remove path: finds the terminal board → fires parkTerminal (which rejects).
    result.current.remove(id)

    // The reject is microtask-async; let it settle, then a couple more macrotasks so jsdom would
    // have dispatched an unhandledrejection if the .catch() were missing.
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 10))

    expect(park).toHaveBeenCalledWith(id)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('a non-terminal board is removed without calling parkTerminal at all', () => {
    const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const { result } = renderHook(() => useBoardActions(makeDeps()))
    result.current.remove(id)
    expect(park).not.toHaveBeenCalled()
  })
})

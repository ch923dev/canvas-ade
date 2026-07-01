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
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'

const park = vi.fn<(id: string) => Promise<boolean>>()
// S3: remove() drops the terminal's persisted scrollback sidecar beside parkTerminal — but ONLY when
// the terminal had a live session (park keeps that for undo); a never-started/exited board keeps its
// sidecar so undo can restore it.
const deleteSnapshot = vi.fn<(id: string) => Promise<boolean>>()

beforeEach(() => {
  vi.clearAllMocks()
  deleteSnapshot.mockResolvedValue(true)
  useTerminalRuntimeStore.setState({ running: {} })
  // Reset the singleton store (mirrors Canvas.pushundo.test.ts) and seed via the real addBoard.
  useCanvasStore.setState({ boards: [], connectors: [], past: [], future: [] })
  ;(
    window as unknown as {
      api: { parkTerminal: typeof park; terminal: { deleteSnapshot: typeof deleteSnapshot } }
    }
  ).api = { parkTerminal: park, terminal: { deleteSnapshot } }
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
    // Real store action so the GROUP-06 "remove from all" path is exercised end-to-end.
    removeBoardFromAllGroups: useCanvasStore.getState().removeBoardFromAllGroups,
    focusBoardById: vi.fn(),
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

describe('S3 — remove() deletes the scrollback sidecar only for a LIVE terminal (undo safety)', () => {
  it('deletes the snapshot when the terminal had a live session (park keeps it for undo)', async () => {
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useTerminalRuntimeStore.getState().setRunning(id, 'running')
    const { result } = renderHook(() => useBoardActions(makeDeps()))
    result.current.remove(id)
    await Promise.resolve()
    expect(deleteSnapshot).toHaveBeenCalledWith(id)
  })

  it('KEEPS the snapshot for a restored-but-never-started (idle) terminal — undo must restore it', async () => {
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    // no setRunning → idle/never-started: nothing parkable, so the sidecar is the only copy.
    const { result } = renderHook(() => useBoardActions(makeDeps()))
    result.current.remove(id)
    await Promise.resolve()
    expect(park).toHaveBeenCalledWith(id)
    expect(deleteSnapshot).not.toHaveBeenCalled()
  })
})

describe('GROUP-05/06 — group membership actions', () => {
  it('GROUP-05: addToGroup adds membership WITHOUT re-packing (the board keeps its position)', () => {
    const st = useCanvasStore.getState()
    const a = st.addBoard('planning', { x: 0, y: 0 })
    const b = st.addBoard('planning', { x: 500, y: 0 })
    const g = useCanvasStore.getState().addGroup('G', [a])
    const before = useCanvasStore.getState().boards.find((x) => x.id === b)!
    const { result } = renderHook(() => useBoardActions(makeDeps()))

    result.current.addToGroup(b, g)

    const after = useCanvasStore.getState()
    expect(after.groups.find((x) => x.id === g)!.boardIds).toContain(b)
    const moved = after.boards.find((x) => x.id === b)!
    expect({ x: moved.x, y: moved.y }).toEqual({ x: before.x, y: before.y })
  })

  it('GROUP-06: removeFromGroup removes the board from ONE group only', () => {
    const st = useCanvasStore.getState()
    const a = st.addBoard('planning', { x: 0, y: 0 })
    const g1 = useCanvasStore.getState().addGroup('G1', [a])
    const g2 = useCanvasStore.getState().addGroup('G2', [a])
    const { result } = renderHook(() => useBoardActions(makeDeps()))

    result.current.removeFromGroup(a, g1)

    const after = useCanvasStore.getState()
    expect(after.groups.find((x) => x.id === g1)!.boardIds).not.toContain(a)
    expect(after.groups.find((x) => x.id === g2)!.boardIds).toContain(a)
  })

  it('GROUP-06: removeFromAllGroups removes the board from every group', () => {
    const st = useCanvasStore.getState()
    const a = st.addBoard('planning', { x: 0, y: 0 })
    const g1 = useCanvasStore.getState().addGroup('G1', [a])
    const g2 = useCanvasStore.getState().addGroup('G2', [a])
    const { result } = renderHook(() => useBoardActions(makeDeps()))

    result.current.removeFromAllGroups(a)

    const after = useCanvasStore.getState()
    expect(after.groups.find((x) => x.id === g1)!.boardIds).not.toContain(a)
    expect(after.groups.find((x) => x.id === g2)!.boardIds).not.toContain(a)
  })
})

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCanvasStore } from '../../store/canvasStore'
import { useGroupInteractions } from './useGroupInteractions'
import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'

// reflowAddToGroup touches none of rf/paneRef/setFocusedId, so minimal stubs suffice.
const stubRf = {} as ReactFlowInstance
const paneRef = { current: null }
const setFocusedId: Dispatch<SetStateAction<string | null>> = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  // Reset the singleton store between tests — mirror canvasStore.test.ts groups section,
  // plus selectedIds so history state doesn't bleed between tests.
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
    tool: 'select',
    past: [],
    future: []
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useGroupInteractions — reflowAddToGroup drives the real store action + reflow choreography', () => {
  it('adds the board to the group, arms the reflow flag, then disarms after 340 ms; packGroupMembers repositions the absorbed board', () => {
    // Seed two planning boards: `a` at origin, `b` far away so packGroupMembers is guaranteed
    // to move it (tidyLayout smart-mode packs both into a row anchored at origin — b at
    // {900,700} will land at most {516+28,0} = {544,0}, a definite position change).
    const a = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const b = useCanvasStore.getState().addBoard('planning', { x: 900, y: 700 })
    const gid = useCanvasStore.getState().addGroup('G1', [a])

    // Capture b's position before the call to assert it moved after the repack.
    const beforeB = useCanvasStore.getState().boards.find((bd) => bd.id === b)!
    const { result } = renderHook(() => useGroupInteractions({ rf: stubRf, paneRef, setFocusedId }))

    // ── arm phase ────────────────────────────────────────────────────────────────────
    act(() => result.current.reflowAddToGroup(gid, [b]))

    const group = useCanvasStore.getState().groups.find((g) => g.id === gid)!
    expect(group.boardIds).toContain(a)
    expect(group.boardIds).toContain(b) // the real addBoardsToGroupReflowed ran (store wiring)
    expect(result.current.reflowing).toBe(true) // the hook armed the .reflowing absorb transition

    // ── position repack proof ─────────────────────────────────────────────────────────
    // packGroupMembers ran tidyLayout('smart') over [a,b]; both are planning boards packed
    // into a single row anchored at origin (0,0) — b at {900,700} is placed at {0,0} or
    // {544,0} depending on id sort order, so at least one coordinate always changes.
    const afterB = useCanvasStore.getState().boards.find((bd) => bd.id === b)!
    expect(afterB.x !== beforeB.x || afterB.y !== beforeB.y).toBe(true)

    // ── disarm phase ──────────────────────────────────────────────────────────────────
    // Advance fake timers past the 340 ms window.setTimeout disarm trigger.
    act(() => vi.advanceTimersByTime(340))
    expect(result.current.reflowing).toBe(false)
  })
})

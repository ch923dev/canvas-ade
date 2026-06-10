// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { useBoardPlacement, useConnectorDrag } from './useBoardPlacement'
import { useCanvasStore } from '../../store/canvasStore'

// Mock rf.screenToFlowPosition as identity (world == screen). Transform correctness is the
// e2e's job; here we test the hook's wiring + click/drag branching.
const rf = { screenToFlowPosition: (p: { x: number; y: number }) => p } as never

function Harness(): ReactElement {
  const { armed, ghost, startPlacement } = useBoardPlacement(rf)
  return (
    <div
      data-testid="cap"
      data-armed={armed}
      data-ghost={ghost ? `${ghost.w}x${ghost.h}` : 'none'}
      onPointerDown={startPlacement}
    />
  )
}

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    selectedId: null,
    tool: 'terminal',
    past: [],
    future: []
  })
})
afterEach(() => cleanup())

// Dispatch window move/up as MouseEvents — the hook reads only clientX/clientY, and a
// MouseEvent on the 'pointermove'/'pointerup' type is caught by the window listeners.
const down = (el: Element, x: number, y: number): void =>
  void fireEvent.pointerDown(el, { clientX: x, clientY: y })
const move = (x: number, y: number): void =>
  act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })))
const up = (x: number, y: number): void =>
  act(() => void window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y })))

describe('useBoardPlacement', () => {
  it('armed reflects a non-select tool', () => {
    const { getByTestId } = render(<Harness />)
    expect(getByTestId('cap').getAttribute('data-armed')).toBe('true')
  })

  it('a drag creates a board sized to the rect, then disarms (tool → select)', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 100, 100)
    move(400, 300)
    up(400, 300)
    const boards = useCanvasStore.getState().boards
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({ type: 'terminal', x: 100, y: 100, w: 300, h: 200 })
    expect(useCanvasStore.getState().tool).toBe('select')
  })

  it('a sub-threshold click creates a DEFAULT-size board centered on the cursor', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 500, 500)
    up(502, 501)
    const b = useCanvasStore.getState().boards[0]
    expect(b).toMatchObject({ type: 'terminal', w: 420, h: 340 })
    expect(Math.round(b.x)).toBe(292)
    expect(Math.round(b.y)).toBe(331)
  })

  it('Escape while armed disarms without creating a board', () => {
    render(<Harness />)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useCanvasStore.getState().boards).toHaveLength(0)
    expect(useCanvasStore.getState().tool).toBe('select')
  })

  it('Escape DURING a drag aborts it — no phantom board on the later pointerup', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 100, 100)
    move(400, 300)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    up(400, 300) // the mouseup that arrives after cancelling must NOT create a board
    expect(useCanvasStore.getState().boards).toHaveLength(0)
    expect(useCanvasStore.getState().tool).toBe('select')
  })

  it('updates the ghost while dragging', () => {
    const { getByTestId } = render(<Harness />)
    expect(getByTestId('cap').getAttribute('data-ghost')).toBe('none')
    down(getByTestId('cap'), 100, 100)
    move(250, 220)
    expect(getByTestId('cap').getAttribute('data-ghost')).toBe('150x120')
  })

  // BUG-011 regression: a capture-phase listener calling stopPropagation() on window must NOT
  // prevent useBoardPlacement's Esc handler from firing. Before the fix, useBoardPlacement
  // registered its listener in bubble phase so a capture-phase stopPropagation() on window
  // silenced it — requiring a second Esc to disarm the placement tool.
  it('BUG-011: single Esc disarms placement even when a capture-phase listener calls stopPropagation()', () => {
    render(<Harness />)
    // Simulate what useCanvasKeybindings does: a capture-phase listener that calls stopPropagation.
    const captureListener = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape') e.stopPropagation()
    }
    window.addEventListener('keydown', captureListener, true)
    try {
      act(
        () =>
          void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      )
      // After ONE Esc press the tool must have reverted to 'select' and no board was created.
      expect(useCanvasStore.getState().tool).toBe('select')
      expect(useCanvasStore.getState().boards).toHaveLength(0)
    } finally {
      window.removeEventListener('keydown', captureListener, true)
    }
  })

  // BUG-035 regression: a second pointerdown while a drag is already in flight (e.g. two-finger
  // touch on a touchscreen) must NOT orphan the first drag's window listeners. Before the fix,
  // dragCleanupRef was overwritten without calling the prior cleanup, leaking pointermove +
  // pointerup listeners for the rest of the component's lifetime.
  it('BUG-035: second pointerdown while drag is in flight cleans up the first drag listeners', () => {
    const { getByTestId } = render(<Harness />)
    const cap = getByTestId('cap')

    // Start first drag
    down(cap, 100, 100)
    // Move to confirm first drag listeners are active
    move(200, 200)
    // Now fire a second pointerdown (e.g. second touch point) — should abort first drag cleanly
    down(cap, 300, 300)
    // After the second pointerdown, a pointerup should create exactly ONE board (the second
    // drag's), not two — and the first drag's onUp must be gone if its listeners were torn down.
    up(350, 350) // resolve second drag via click (small move)
    const boards = useCanvasStore.getState().boards
    // Exactly one board created (from the second drag/click), not two phantom boards
    expect(boards).toHaveLength(1)
    // Tool returns to select
    expect(useCanvasStore.getState().tool).toBe('select')
    // Subsequent pointer events after completion must not fire orphaned listeners
    // (if they did, a third pointerup would add a second board)
    act(
      () => void window.dispatchEvent(new MouseEvent('pointerup', { clientX: 400, clientY: 400 }))
    )
    expect(useCanvasStore.getState().boards).toHaveLength(1)
  })

  // BUG-046 regression: a right/middle press while a placement tool is armed must NOT start
  // the gesture — before the fix, the right-button pointerup committed a phantom board.
  it('BUG-046: a non-primary (right-button) pointerdown does not place a board', () => {
    const { getByTestId } = render(<Harness />)
    fireEvent.pointerDown(getByTestId('cap'), { clientX: 100, clientY: 100, button: 2 })
    up(120, 110)
    expect(useCanvasStore.getState().boards).toHaveLength(0)
    // The press is ignored (not a cancel) — the tool stays armed for the real left-click.
    expect(useCanvasStore.getState().tool).toBe('terminal')
  })

  // BUG-047 regression: an OS focus steal mid-drag swallows the pointerup; the stale window
  // listeners must be torn down or a later, unrelated pointerup commits a phantom board
  // spanning from the abandoned origin.
  it('BUG-047: window blur during a drag aborts it — a later pointerup creates nothing', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 100, 100)
    move(400, 300)
    act(() => void window.dispatchEvent(new Event('blur')))
    up(400, 300)
    expect(useCanvasStore.getState().boards).toHaveLength(0)
    expect(getByTestId('cap').getAttribute('data-ghost')).toBe('none')
    expect(useCanvasStore.getState().tool).toBe('terminal') // only the drag died; still armed
  })

  it('BUG-047: pointercancel during a drag aborts it — a later pointerup creates nothing', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 100, 100)
    move(400, 300)
    act(() => void window.dispatchEvent(new Event('pointercancel')))
    up(400, 300)
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })
})

// ── useConnectorDrag (M2 rubber-band, moved here from Canvas.tsx) ──────────────────────

/** Drives the connector gesture with the source pre-armed (as if the handle was pressed). */
function ConnectorHarness(): ReactElement {
  const [connectFromId, setConnectFromId] = useState<string | null>('src')
  const addConnector = useCanvasStore((s) => s.addConnector)
  useConnectorDrag({
    rf,
    connectFromId,
    setConnectFromId,
    setConnectPointer: () => {},
    addConnector
  })
  return <div data-testid="armed" data-armed={connectFromId !== null} />
}

describe('useConnectorDrag', () => {
  beforeEach(() => {
    const add = useCanvasStore.getState().addBoard
    add('terminal', { x: 0, y: 0 }, { id: 'src', size: { w: 100, h: 100 }, exact: true })
    add('terminal', { x: 200, y: 0 }, { id: 'dst', size: { w: 100, h: 100 }, exact: true })
  })

  it('releasing over another board commits an orchestration connector', () => {
    render(<ConnectorHarness />)
    up(250, 50) // inside dst (screenToFlowPosition is identity)
    const connectors = useCanvasStore.getState().connectors
    expect(connectors).toHaveLength(1)
    expect(connectors[0]).toMatchObject({ sourceId: 'src', targetId: 'dst', kind: 'orchestration' })
  })

  // BUG-048 regressions: the gesture must ABORT (no commit, listeners gone) on Esc, window
  // blur (Alt+Tab swallows the pointerup), or pointercancel — before the fix the armed
  // listeners survived and the next pointerup over a board silently committed a connector.
  it('BUG-048: Esc aborts — a later pointerup over a board commits nothing', () => {
    const { getByTestId } = render(<ConnectorHarness />)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(getByTestId('armed').getAttribute('data-armed')).toBe('false')
    up(250, 50)
    expect(useCanvasStore.getState().connectors).toHaveLength(0)
  })

  it('BUG-048: window blur aborts — the re-focusing click commits nothing', () => {
    const { getByTestId } = render(<ConnectorHarness />)
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(getByTestId('armed').getAttribute('data-armed')).toBe('false')
    up(250, 50)
    expect(useCanvasStore.getState().connectors).toHaveLength(0)
  })

  it('BUG-048: pointercancel aborts — a later pointerup commits nothing', () => {
    render(<ConnectorHarness />)
    act(() => void window.dispatchEvent(new Event('pointercancel')))
    up(250, 50)
    expect(useCanvasStore.getState().connectors).toHaveLength(0)
  })
})

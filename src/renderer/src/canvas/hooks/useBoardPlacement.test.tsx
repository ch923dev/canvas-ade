// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import { useBoardPlacement } from './useBoardPlacement'
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
})

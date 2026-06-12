// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Dock } from './AppChrome'
import { useCanvasStore } from '../store/canvasStore'

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    selectedId: null,
    tool: 'select',
    past: [],
    future: []
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Dock arms a board type (drag-to-create)', () => {
  it('clicking +Terminal sets tool to terminal and adds NO board', () => {
    render(<Dock />)
    fireEvent.click(screen.getByText('Terminal'))
    expect(useCanvasStore.getState().tool).toBe('terminal')
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })

  it('clicking Select clears the armed tool back to select', () => {
    useCanvasStore.setState({ tool: 'browser' })
    render(<Dock />)
    fireEvent.click(screen.getByTitle('Select'))
    expect(useCanvasStore.getState().tool).toBe('select')
  })
})

// Auto-hide: the pill hides behind the slim handle unless hovered, focused, armed,
// or the canvas is empty. Asserted via data-revealed (the CSS carries the visuals).
describe('Dock auto-hide (slim handle reveal)', () => {
  const pill = (c: HTMLElement): Element => c.querySelector('.ca-dock-pill')!
  const handle = (c: HTMLElement): Element => c.querySelector('.ca-dock-handle')!
  const seedBoard = (): void => {
    useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  }

  it('stays pinned open on an empty canvas (EmptyState mirrors it)', () => {
    const { container } = render(<Dock />)
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
  })

  it('hides the pill behind the handle once boards exist and nothing is armed', () => {
    seedBoard()
    const { container } = render(<Dock />)
    expect(pill(container).getAttribute('data-revealed')).toBe('false')
    expect(handle(container).getAttribute('data-revealed')).toBe('false')
  })

  it('reveals on handle hover and hides again after the leave grace delay', () => {
    vi.useFakeTimers()
    seedBoard()
    const { container } = render(<Dock />)
    fireEvent.pointerEnter(handle(container))
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
    fireEvent.pointerLeave(handle(container))
    // Still revealed within the grace window…
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
    act(() => vi.advanceTimersByTime(400))
    expect(pill(container).getAttribute('data-revealed')).toBe('false')
  })

  it('re-entering within the grace window cancels the pending hide', () => {
    vi.useFakeTimers()
    seedBoard()
    const { container } = render(<Dock />)
    fireEvent.pointerEnter(handle(container))
    fireEvent.pointerLeave(handle(container))
    fireEvent.pointerEnter(pill(container))
    act(() => vi.advanceTimersByTime(1000))
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
  })

  it('stays pinned while a board type is armed', () => {
    seedBoard()
    useCanvasStore.setState({ tool: 'browser' })
    const { container } = render(<Dock />)
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
  })

  it('reveals while keyboard focus is inside the pill', () => {
    seedBoard()
    const { container } = render(<Dock />)
    act(() => screen.getByTitle('Select').focus())
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
    act(() => screen.getByTitle('Select').blur())
    expect(pill(container).getAttribute('data-revealed')).toBe('false')
  })
})

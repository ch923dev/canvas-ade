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

// Auto-hide: the pill hides behind the slim handle unless the mouse moves within the
// top-center proximity zone, focus is inside, a tool is armed, or the canvas is empty.
// Asserted via data-revealed (the CSS carries the visuals). jsdom geometry note: every
// getBoundingClientRect is all-zeros here, so the zone resolves to x∈[-300,300],
// y∈[-14,106] — IN_ZONE/OUT_ZONE below are chosen against that, not real layout.
describe('Dock auto-hide (proximity-zone reveal)', () => {
  const pill = (c: HTMLElement): Element => c.querySelector('.ca-dock-pill')!
  const handle = (c: HTMLElement): Element => c.querySelector('.ca-dock-handle')!
  const seedBoard = (): void => {
    useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  }
  const IN_ZONE = { clientX: 0, clientY: 40 }
  const OUT_ZONE = { clientX: 1200, clientY: 700 }
  const moveTo = (pt: { clientX: number; clientY: number }): void => {
    fireEvent.pointerMove(window, pt)
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

  it('reveals after movement holds in the zone past the entrance delay', () => {
    vi.useFakeTimers()
    seedBoard()
    const { container } = render(<Dock />)
    moveTo(IN_ZONE)
    // Not yet — the entrance delay is still running.
    expect(pill(container).getAttribute('data-revealed')).toBe('false')
    act(() => vi.advanceTimersByTime(100))
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
  })

  it('a fast pass-through never flashes the dock', () => {
    vi.useFakeTimers()
    seedBoard()
    const { container } = render(<Dock />)
    moveTo(IN_ZONE)
    moveTo(OUT_ZONE) // exits before the entrance delay elapses
    act(() => vi.advanceTimersByTime(1000))
    expect(pill(container).getAttribute('data-revealed')).toBe('false')
  })

  it('hides after the grace delay once the cursor exits the zone', () => {
    vi.useFakeTimers()
    seedBoard()
    const { container } = render(<Dock />)
    moveTo(IN_ZONE)
    act(() => vi.advanceTimersByTime(100))
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
    moveTo(OUT_ZONE)
    // Still revealed within the grace window…
    expect(pill(container).getAttribute('data-revealed')).toBe('true')
    act(() => vi.advanceTimersByTime(1500))
    expect(pill(container).getAttribute('data-revealed')).toBe('false')
  })

  it('re-entering the zone within the grace window cancels the pending hide', () => {
    vi.useFakeTimers()
    seedBoard()
    const { container } = render(<Dock />)
    moveTo(IN_ZONE)
    act(() => vi.advanceTimersByTime(100))
    moveTo(OUT_ZONE)
    moveTo(IN_ZONE)
    act(() => vi.advanceTimersByTime(3000))
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

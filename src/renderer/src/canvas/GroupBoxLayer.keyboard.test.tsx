// @vitest-environment jsdom
/**
 * GROUP-02 — the group name-tab is fully keyboard-operable and no longer flashes
 * select-then-focus on a double-click. Renders the real GroupBoxLayer inside a
 * ReactFlowProvider (it reads the live camera transform via useStore) with the canvas
 * store seeded so exactly one box + tab renders.
 *
 * globals: false — import vitest helpers explicitly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { GroupBoxLayer, type GroupBoxLayerProps } from './GroupBoxLayer'
import { useCanvasStore } from '../store/canvasStore'
import type { Board } from '../lib/boardSchema'

afterEach(cleanup)

const SEED_BOARDS = [
  { id: 'a', type: 'planning', x: 0, y: 0, w: 100, h: 100, title: '', elements: [] },
  { id: 'b', type: 'planning', x: 200, y: 0, w: 100, h: 100, title: '', elements: [] }
] as unknown as Board[]

function seed(): void {
  useCanvasStore.setState({
    groups: [{ id: 'g1', name: 'Auth', boardIds: ['a', 'b'] }],
    boards: SEED_BOARDS
  })
}

function renderLayer(props: GroupBoxLayerProps): void {
  render(
    <ReactFlowProvider>
      <GroupBoxLayer {...props} />
    </ReactFlowProvider>
  )
}

describe('GroupBoxLayer tab — GROUP-02 keyboard + click debounce', () => {
  beforeEach(seed)
  afterEach(() => useCanvasStore.setState({ groups: [], boards: [] }))

  it('exposes the tab as a labelled button', () => {
    renderLayer({})
    expect(screen.getByRole('button', { name: 'Group: Auth' })).toBeTruthy()
  })

  it('Enter focuses the group (onTabDoubleClick), not select', () => {
    const onTabClick = vi.fn()
    const onTabDoubleClick = vi.fn()
    renderLayer({ onTabClick, onTabDoubleClick })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Group: Auth' }), { key: 'Enter' })
    expect(onTabDoubleClick).toHaveBeenCalledWith('g1')
    expect(onTabClick).not.toHaveBeenCalled()
  })

  it('Shift+F10 opens the manage menu (onTabContextMenu) at the tab', () => {
    const onTabContextMenu = vi.fn()
    renderLayer({ onTabContextMenu })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Group: Auth' }), {
      key: 'F10',
      shiftKey: true
    })
    expect(onTabContextMenu).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
    )
  })

  it('a lone single click selects members after the debounce', () => {
    vi.useFakeTimers()
    try {
      const onTabClick = vi.fn()
      renderLayer({ onTabClick })
      fireEvent.click(screen.getByRole('button', { name: 'Group: Auth' }), { detail: 1 })
      expect(onTabClick).not.toHaveBeenCalled() // deferred so a dblclick can cancel it
      act(() => void vi.advanceTimersByTime(300))
      expect(onTabClick).toHaveBeenCalledWith('g1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a double-click focuses and CANCELS the pending select (no flash)', () => {
    vi.useFakeTimers()
    try {
      const onTabClick = vi.fn()
      const onTabDoubleClick = vi.fn()
      renderLayer({ onTabClick, onTabDoubleClick })
      const tab = screen.getByRole('button', { name: 'Group: Auth' })
      fireEvent.click(tab, { detail: 1 })
      fireEvent.dblClick(tab)
      act(() => void vi.advanceTimersByTime(300))
      expect(onTabDoubleClick).toHaveBeenCalledWith('g1')
      expect(onTabClick).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

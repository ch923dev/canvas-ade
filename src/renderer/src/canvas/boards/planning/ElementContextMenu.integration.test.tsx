import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ElementContextMenu, type MenuEntry } from './ElementContextMenu'

afterEach(cleanup)

const actions = (onSelect = vi.fn()): MenuEntry[] => [
  { kind: 'action', id: 'lock', label: 'Lock', onSelect },
  { kind: 'action', id: 'group', label: 'Group', disabled: true, onSelect },
  {
    kind: 'iconRow',
    id: 'align',
    label: 'Align',
    buttons: [{ id: 'left', title: 'Align left', icon: 'align-left', onSelect }]
  }
]

describe('ElementContextMenu', () => {
  it('renders entries and fires onSelect + onClose on an action click', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions(onSelect)} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('w3-menu-lock'))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not fire a disabled action', () => {
    const onSelect = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions(onSelect)} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('w3-menu-group'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders an icon-row button that fires + closes', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions(onSelect)} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('w3-menu-align-left'))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

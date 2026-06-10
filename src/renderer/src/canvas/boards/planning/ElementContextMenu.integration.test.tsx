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

const swatchRow = (onSelect = vi.fn(), disabled = false): MenuEntry[] => [
  {
    kind: 'swatchRow',
    id: 'tint',
    label: 'Tint',
    disabled,
    swatches: [
      { id: 'yellow', title: 'Yellow tint', fill: '#2a2818', edge: '#3d3a22', onSelect },
      { id: 'blue', title: 'Blue tint', fill: '#16202b', edge: '#22354a', current: true, onSelect }
    ]
  }
]

describe('ElementContextMenu swatchRow (D3-A tint picker)', () => {
  it('renders a menuitem swatch per tint that fires + closes', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={swatchRow(onSelect)} onClose={onClose} />)
    const yellow = screen.getByTestId('w3-menu-tint-yellow')
    expect(yellow.getAttribute('role')).toBe('menuitem')
    fireEvent.click(yellow)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('marks only the current tint swatch', () => {
    render(<ElementContextMenu x={10} y={10} entries={swatchRow()} onClose={vi.fn()} />)
    expect(screen.getByTestId('w3-menu-tint-blue').hasAttribute('data-current')).toBe(true)
    expect(screen.getByTestId('w3-menu-tint-yellow').hasAttribute('data-current')).toBe(false)
  })

  it('paints the swatch with its tint fill + edge border', () => {
    render(<ElementContextMenu x={10} y={10} entries={swatchRow()} onClose={vi.fn()} />)
    const el = screen.getByTestId('w3-menu-tint-yellow')
    expect(el.style.background).toBe('rgb(42, 40, 24)') // #2a2818
    expect(el.style.border).toContain('1px solid')
  })

  it('does not fire when the row is disabled', () => {
    const onSelect = vi.fn()
    render(
      <ElementContextMenu x={10} y={10} entries={swatchRow(onSelect, true)} onClose={vi.fn()} />
    )
    fireEvent.click(screen.getByTestId('w3-menu-tint-yellow'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

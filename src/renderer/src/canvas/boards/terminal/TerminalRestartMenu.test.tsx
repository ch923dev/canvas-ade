// @vitest-environment jsdom
/**
 * D2-B: the restart popover rides the shared Menu shell — items are `menuitem`s,
 * picking one closes the menu, and the shell's Escape auto-close applies (the old
 * hand-rolled version had no dismissal paths — the audit's "no auto-close").
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { TerminalRestartMenu } from './TerminalRestartMenu'

afterEach(cleanup)

function renderMenu(): {
  onResume: ReturnType<typeof vi.fn>
  onNew: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const anchor = document.createElement('span')
  document.body.appendChild(anchor)
  const onResume = vi.fn()
  const onNew = vi.fn()
  const onClose = vi.fn()
  render(
    <TerminalRestartMenu
      anchor={{ current: anchor }}
      onResume={onResume}
      onNew={onNew}
      onClose={onClose}
    />
  )
  return { onResume, onNew, onClose }
}

describe('TerminalRestartMenu (shared Menu shell)', () => {
  it('renders Resume/New as menuitems inside a labelled menu', () => {
    renderMenu()
    expect(screen.getByRole('menu', { name: 'Restart terminal' })).toBeTruthy()
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.textContent)).toEqual(['Resume session', 'New session'])
  })

  it('picking Resume closes first, then fires the action', () => {
    const calls: string[] = []
    const anchor = document.createElement('span')
    document.body.appendChild(anchor)
    render(
      <TerminalRestartMenu
        anchor={{ current: anchor }}
        onResume={() => calls.push('resume')}
        onNew={() => calls.push('new')}
        onClose={() => calls.push('close')}
      />
    )
    fireEvent.click(screen.getByText('Resume session'))
    expect(calls).toEqual(['close', 'resume'])
  })

  it('New session fires onNew + onClose; Escape auto-closes (shell behavior)', () => {
    const { onNew, onClose } = renderMenu()
    fireEvent.click(screen.getByText('New session'))
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

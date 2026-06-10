// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectSwitcher } from './AppChrome'

// `globals: false` in vitest.config → RTL auto-cleanup isn't registered; clean up by hand.
beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    project: { recents: vi.fn().mockResolvedValue([]) }
  }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ProjectSwitcher outside-close (project-switcher-no-outside-close)', () => {
  const open = async (): Promise<void> => {
    fireEvent.click(screen.getByTitle('Switch project'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  }

  it('closes the open dropdown on an outside pointerdown', async () => {
    render(<ProjectSwitcher />)
    await open()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('closes the open dropdown on Escape', async () => {
    render(<ProjectSwitcher />)
    await open()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('closes (does not reopen) when the trigger is re-clicked while open', async () => {
    render(<ProjectSwitcher />)
    await open()
    const trigger = screen.getByTitle('Switch project')
    // Real input is pointerdown THEN click. The outside-close listens on pointerdown, so without
    // a stopPropagation on the trigger the pointerdown closes and the click reopens (stays open).
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  // D1-C: the dropdown renders through the shared Menu shell — every row is a menuitem
  // and arrow keys walk the roving focus (no recents mocked → Open folder / Create project).
  it('D1-C: rows are menuitems; ArrowDown walks the roving focus', async () => {
    render(<ProjectSwitcher />)
    await open()
    const items = screen.getAllByRole('menuitem')
    expect(items.map((b) => b.textContent?.trim())).toEqual(['Open folder…', 'Create project…'])
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
  })
})

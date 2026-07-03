// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectSwitcher } from './ProjectSwitcher'

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

// Phase 4 (PHASE4-UX-DESIGN §2): live recents rows — dot + counts badge + hover-✕ for a
// backgrounded resident, the ∞ forget badge for a persisted keep, plain rows untouched.
describe('ProjectSwitcher live rows (background project sessions, Phase 4)', () => {
  const bgAlpha = {
    dir: 'C:\\work\\alpha',
    name: 'alpha',
    terminalsRunning: 2,
    previews: 1,
    backgroundedAt: 1
  }
  const recents = [
    { path: 'C:\\work\\alpha', name: 'alpha' },
    { path: 'C:\\work\\beta', name: 'beta' }
  ]
  let forgetKeepPolicy: ReturnType<typeof vi.fn>
  let closeBackground: ReturnType<typeof vi.fn>

  beforeEach(() => {
    forgetKeepPolicy = vi.fn().mockResolvedValue(true)
    closeBackground = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue(recents),
        listBackground: vi.fn().mockResolvedValue([bgAlpha]),
        keepForeverDirs: vi.fn().mockResolvedValue(['C:\\work\\alpha']),
        forgetKeepPolicy,
        closeBackground
      }
    }
  })

  const open = async (): Promise<void> => {
    fireEvent.click(screen.getByTitle('Switch project'))
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  }

  it('decorates a backgrounded resident (badge + ✕ + ∞) and leaves a plain recent bare', async () => {
    render(<ProjectSwitcher />)
    await open()
    await waitFor(() => expect(screen.getByText('2 term · 1 prev')).toBeTruthy())
    expect(screen.getByLabelText('Close background project alpha')).toBeTruthy()
    expect(screen.getByLabelText('Stop always keeping alpha in the background')).toBeTruthy()
    // beta: no badge, no aux buttons.
    expect(screen.queryByLabelText('Close background project beta')).toBeNull()
    expect(screen.queryByLabelText('Stop always keeping beta in the background')).toBeNull()
  })

  it('∞ click forgets the keep policy (sessions untouched — closeBackground never called)', async () => {
    render(<ProjectSwitcher />)
    await open()
    await waitFor(() =>
      expect(screen.getByLabelText('Stop always keeping alpha in the background')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('Stop always keeping alpha in the background'))
    await waitFor(() => expect(forgetKeepPolicy).toHaveBeenCalledWith('C:\\work\\alpha'))
    expect(closeBackground).not.toHaveBeenCalled()
  })

  it('✕ on a RUNNING resident opens the confirm; Stop & close disposes, Cancel does not', async () => {
    render(<ProjectSwitcher />)
    await open()
    await waitFor(() =>
      expect(screen.getByLabelText('Close background project alpha')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('Close background project alpha'))
    // The §3 confirm carries the consequence; nothing disposed until confirmed.
    await waitFor(() => expect(screen.getByTestId('close-bg-modal')).toBeTruthy())
    expect(closeBackground).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('close-bg-cancel'))
    await waitFor(() => expect(screen.queryByTestId('close-bg-modal')).toBeNull())
    expect(closeBackground).not.toHaveBeenCalled()

    // Re-open and confirm this time.
    await open()
    fireEvent.click(screen.getByLabelText('Close background project alpha'))
    await waitFor(() => expect(screen.getByTestId('close-bg-modal')).toBeTruthy())
    fireEvent.click(screen.getByTestId('close-bg-confirm'))
    await waitFor(() => expect(closeBackground).toHaveBeenCalledWith('C:\\work\\alpha'))
  })

  it('✕ on an IDLE resident (everything exited) closes silently — no modal', async () => {
    ;(
      window as unknown as {
        api: { project: { listBackground: ReturnType<typeof vi.fn> } }
      }
    ).api.project.listBackground = vi
      .fn()
      .mockResolvedValue([{ ...bgAlpha, terminalsRunning: 0, previews: 0 }])
    render(<ProjectSwitcher />)
    await open()
    await waitFor(() =>
      expect(screen.getByLabelText('Close background project alpha')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('Close background project alpha'))
    await waitFor(() => expect(closeBackground).toHaveBeenCalledWith('C:\\work\\alpha'))
    expect(screen.queryByTestId('close-bg-modal')).toBeNull()
  })
})

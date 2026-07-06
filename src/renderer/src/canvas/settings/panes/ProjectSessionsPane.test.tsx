// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectSessionsPane } from './ProjectSessionsPane'
import { useCanvasStore } from '../../../store/canvasStore'

/**
 * Project · Sessions pane — the "Keep in background" toggle over the existing keep-policy IPC.
 * Asserts the persisted-forever mapping: hydrate from keepForeverDirs; ON → setKeepPolicy(true);
 * OFF → forgetKeepPolicy(dir) (there is no setKeepPolicy(false)); gate to the empty state with no
 * project open.
 */

afterEach(cleanup)

const project = {
  keepForeverDirs: vi.fn(),
  setKeepPolicy: vi.fn(),
  forgetKeepPolicy: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  project.keepForeverDirs.mockResolvedValue([])
  project.setKeepPolicy.mockResolvedValue(true)
  project.forgetKeepPolicy.mockResolvedValue(true)
  ;(window as unknown as { api: { project: typeof project } }).api = { project }
  useCanvasStore.setState({ project: { dir: '/proj/x', name: 'x', status: 'open' } })
})

const sw = (): HTMLButtonElement =>
  screen.getByRole('switch', { name: 'Keep in background' }) as HTMLButtonElement

describe('keep in background toggle', () => {
  it('hydrates OFF when the active dir is not in the forever set', async () => {
    render(<ProjectSessionsPane />)
    await waitFor(() => expect(project.keepForeverDirs).toHaveBeenCalled())
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('hydrates ON when the active dir is in the forever set', async () => {
    project.keepForeverDirs.mockResolvedValue(['/proj/x'])
    render(<ProjectSessionsPane />)
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'))
  })

  it('turning ON calls setKeepPolicy(true) and reflects checked', async () => {
    render(<ProjectSessionsPane />)
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(sw())
    await waitFor(() => expect(project.setKeepPolicy).toHaveBeenCalledWith(true))
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'))
    expect(project.forgetKeepPolicy).not.toHaveBeenCalled()
  })

  it('turning OFF calls forgetKeepPolicy(dir) — never setKeepPolicy(false)', async () => {
    project.keepForeverDirs.mockResolvedValue(['/proj/x'])
    render(<ProjectSessionsPane />)
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(sw())
    await waitFor(() => expect(project.forgetKeepPolicy).toHaveBeenCalledWith('/proj/x'))
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'))
    expect(project.setKeepPolicy).not.toHaveBeenCalled()
  })

  it('surfaces an error and keeps the prior state when the write fails', async () => {
    project.setKeepPolicy.mockResolvedValue(false)
    render(<ProjectSessionsPane />)
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(sw())
    await waitFor(() =>
      expect(
        (document.querySelector('[data-test="settings-keep-background-error"]') as HTMLElement)
          ?.textContent
      ).toMatch(/keep in background/i)
    )
    expect(sw().getAttribute('aria-checked')).toBe('false') // never adopted the failed value
  })

  it('shows the empty state with no project open (no IPC)', () => {
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
    render(<ProjectSessionsPane />)
    expect(document.querySelector('[data-test="settings-no-project"]')).not.toBeNull()
    expect(screen.queryByRole('switch', { name: 'Keep in background' })).toBeNull()
    expect(project.keepForeverDirs).not.toHaveBeenCalled()
  })
})

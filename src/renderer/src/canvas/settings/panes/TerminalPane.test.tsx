// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { TerminalPane } from './TerminalPane'
import { useCanvasStore } from '../../../store/canvasStore'

/**
 * Terminal pane coverage — the agent-recap consent toggle, migrated from the retired
 * `SettingsModal.test.tsx` when it became the `terminal` tile. Immediate-apply (no Save), with the
 * BUG-065 optimistic-then-revert guard: a rejected / `{ok:false}` write must never leave the box
 * showing a state that did not persist (privacy-relevant on untick — the recap hook stays installed).
 */

afterEach(cleanup)

const recap = { getConsent: vi.fn(), setConsent: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  recap.getConsent.mockResolvedValue('undecided')
  recap.setConsent.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: { recap: typeof recap } }).api = { recap }
  useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
})

describe('Agent recaps toggle', () => {
  const findToggle = async (): Promise<HTMLInputElement> =>
    (await screen.findByLabelText(/agent recaps \(this project\)/i)) as HTMLInputElement

  it('is disabled with a hint when no project is open (project.dir === null)', async () => {
    recap.getConsent.mockResolvedValue('declined')
    render(<TerminalPane />)
    const toggle = await findToggle()
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/open a project to enable/i)).toBeTruthy()
  })

  it('is enabled and unchecked when a project is open and consent is declined', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('declined')
    render(<TerminalPane />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.disabled).toBe(false))
    expect(toggle.checked).toBe(false)
  })

  it('is checked when consent is enabled', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('enabled')
    render(<TerminalPane />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  it('calls setConsent("enabled") and checks the box when toggled on', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('declined')
    render(<TerminalPane />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.disabled).toBe(false))
    fireEvent.click(toggle)
    expect(recap.setConsent).toHaveBeenCalledWith('enabled')
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  it('calls setConsent("declined") and unchecks the box when toggled off', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('enabled')
    render(<TerminalPane />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
    fireEvent.click(toggle)
    expect(recap.setConsent).toHaveBeenCalledWith('declined')
    await waitFor(() => expect(toggle.checked).toBe(false))
  })

  it('BUG-065: reverts the toggle and shows an error on a resolved {ok:false}', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('enabled')
    recap.setConsent.mockResolvedValue({ ok: false })
    render(<TerminalPane />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
    fireEvent.click(toggle) // untick — but MAIN reports nothing was persisted
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/agent recaps/i))
    // The optimistic untick was reverted: the hook is still installed, the UI must say so.
    expect(toggle.checked).toBe(true)
  })

  it('BUG-065: a setConsent rejection reverts the toggle without an unhandledRejection', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('declined')
    recap.setConsent.mockRejectedValue(new Error('ENOSPC'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    render(<TerminalPane />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.disabled).toBe(false))
    fireEvent.click(toggle) // tick — but the write throws (disk full)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/agent recaps/i))
    expect(toggle.checked).toBe(false) // reverted — recaps were never enabled
    await new Promise((r) => setTimeout(r, 10))
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })

  it('re-reads consent when the open project changes (projectDir dep)', async () => {
    recap.getConsent.mockResolvedValue('declined')
    render(<TerminalPane />)
    await waitFor(() => expect(recap.getConsent).toHaveBeenCalledTimes(1))

    recap.getConsent.mockResolvedValue('enabled')
    useCanvasStore.setState({
      project: { dir: '/new/project', name: 'new-project', status: 'open' }
    })

    await waitFor(() => expect(recap.getConsent).toHaveBeenCalledTimes(2))
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  it('loads consent with a cancellation guard (post-unmount resolve is a no-op)', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    let resolveConsent: (v: string) => void = () => {}
    recap.getConsent.mockReturnValue(
      new Promise((res) => {
        resolveConsent = res as (v: string) => void
      })
    )
    const err = vi.spyOn(console, 'error')
    const { unmount } = render(<TerminalPane />)
    unmount()
    resolveConsent('enabled')
    await new Promise((r) => setTimeout(r, 5))
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

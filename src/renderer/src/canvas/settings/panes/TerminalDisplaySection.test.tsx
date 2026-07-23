// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { TerminalDisplaySection } from './TerminalDisplaySection'

/**
 * Flicker-free terminals toggle (T1d) — immediate-apply (no Save) with the BUG-065
 * optimistic-then-revert guard: a rejected / `{ok:false}` write must never leave the switch showing a
 * state that did not persist. Renders null without `window.api.terminalDisplay` (settings-modal unit
 * mocks stay green without the preload).
 */

afterEach(cleanup)

const terminalDisplay = { get: vi.fn(), set: vi.fn() }

const setApi = (present: boolean): void => {
  ;(window as unknown as { api: unknown }).api = present ? { terminalDisplay } : {}
}

beforeEach(() => {
  vi.clearAllMocks()
  terminalDisplay.get.mockResolvedValue({ flickerFree: false })
  terminalDisplay.set.mockResolvedValue({ ok: true })
  setApi(true)
})

const findToggle = async (): Promise<HTMLButtonElement> =>
  (await screen.findByRole('switch', { name: /flicker-free terminals/i })) as HTMLButtonElement

describe('TerminalDisplaySection', () => {
  it('renders nothing when the preload api is absent', () => {
    setApi(false)
    const { container } = render(<TerminalDisplaySection />)
    expect(container.firstChild).toBeNull()
  })

  it('reflects the persisted OFF state', async () => {
    render(<TerminalDisplaySection />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('reflects the persisted ON state', async () => {
    terminalDisplay.get.mockResolvedValue({ flickerFree: true })
    render(<TerminalDisplaySection />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })

  it('persists flickerFree:true and flips the switch on', async () => {
    render(<TerminalDisplaySection />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(toggle)
    expect(terminalDisplay.set).toHaveBeenCalledWith({ flickerFree: true })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })

  it('BUG-065: reverts and shows an error on a resolved {ok:false}', async () => {
    terminalDisplay.get.mockResolvedValue({ flickerFree: false })
    terminalDisplay.set.mockResolvedValue({ ok: false })
    render(<TerminalDisplaySection />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(toggle) // optimistic ON — but MAIN reports nothing persisted
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/terminal display/i))
    expect(toggle.getAttribute('aria-checked')).toBe('false') // reverted
  })

  it('BUG-065: a set rejection reverts without an unhandledRejection', async () => {
    terminalDisplay.get.mockResolvedValue({ flickerFree: true })
    terminalDisplay.set.mockRejectedValue(new Error('ENOSPC'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    render(<TerminalDisplaySection />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(toggle) // optimistic OFF — but the write throws
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/terminal display/i))
    expect(toggle.getAttribute('aria-checked')).toBe('true') // reverted
    await new Promise((r) => setTimeout(r, 10))
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })
})

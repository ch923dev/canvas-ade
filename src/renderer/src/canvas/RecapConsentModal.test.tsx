// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { RecapConsentModal } from './RecapConsentModal'
import { ToastIsland } from './Toast'
import { useToastStore } from '../store/toastStore'

type ApiWindow = { api: { recap: { setConsent: ReturnType<typeof vi.fn> } } }

afterEach(cleanup)

describe('RecapConsentModal', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts()
    ;(window as unknown as ApiWindow).api = {
      recap: { setConsent: vi.fn().mockResolvedValue({ ok: true }) }
    }
  })

  it('Enable → setConsent("enabled") + closes', async () => {
    const onClose = vi.fn()
    render(<RecapConsentModal onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable recaps/i }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((window as unknown as ApiWindow).api.recap.setConsent).toHaveBeenCalledWith('enabled')
  })

  it('No thanks → setConsent("declined") + closes', async () => {
    const onClose = vi.fn()
    render(<RecapConsentModal onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /no thanks/i }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((window as unknown as ApiWindow).api.recap.setConsent).toHaveBeenCalledWith('declined')
  })

  it('keeps the modal open + shows an error toast when setConsent rejects', async () => {
    ;(window as unknown as ApiWindow).api.recap.setConsent.mockRejectedValueOnce(
      new Error('ipc gone')
    )
    const onClose = vi.fn()
    // D1-A: the error surfaces on the app toast channel (ToastIsland), not inline.
    render(
      <>
        <RecapConsentModal onClose={onClose} />
        <ToastIsland />
      </>
    )
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable recaps/i }))
    const alert = await screen.findByRole('alert') // the error toast surfaced
    expect(alert.textContent).toMatch(/couldn.t save your choice/i)
    // …on the toast island, NOT inline in the dialog (the old D0-era surface).
    expect(alert.closest('[data-test=toast-island]')).not.toBeNull()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(onClose).not.toHaveBeenCalled() // NOT closed on a failed save
    const enable = within(dialog).getByRole('button', { name: /enable recaps/i })
    expect((enable as HTMLButtonElement).disabled).toBe(false) // re-enabled for a retry
  })

  it('BUG-066: keeps the modal open + shows an error toast on a resolved {ok:false}', async () => {
    ;(window as unknown as ApiWindow).api.recap.setConsent.mockResolvedValueOnce({ ok: false })
    const onClose = vi.fn()
    render(
      <>
        <RecapConsentModal onClose={onClose} />
        <ToastIsland />
      </>
    )
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable recaps/i }))
    const alert = await screen.findByRole('alert') // the error toast surfaced
    expect(alert.closest('[data-test=toast-island]')).not.toBeNull()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(onClose).not.toHaveBeenCalled() // NOT closed — nothing was persisted
    const enable = within(dialog).getByRole('button', { name: /enable recaps/i })
    expect((enable as HTMLButtonElement).disabled).toBe(false) // re-enabled for a retry
  })

  it('renders the privacy assurance text', () => {
    render(<RecapConsentModal onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    expect(dialog.textContent).toMatch(/nothing is ever sent to us/i)
  })

  it('Escape key calls onClose when not busy', () => {
    const onClose = vi.fn()
    render(<RecapConsentModal onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

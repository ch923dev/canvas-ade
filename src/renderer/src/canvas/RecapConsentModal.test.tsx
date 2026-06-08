// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { RecapConsentModal } from './RecapConsentModal'

type ApiWindow = { api: { recap: { setConsent: ReturnType<typeof vi.fn> } } }

afterEach(cleanup)

describe('RecapConsentModal', () => {
  beforeEach(() => {
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

  it('keeps the modal open + shows an error when setConsent rejects', async () => {
    ;(window as unknown as ApiWindow).api.recap.setConsent.mockRejectedValueOnce(
      new Error('ipc gone')
    )
    const onClose = vi.fn()
    render(<RecapConsentModal onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable recaps/i }))
    await screen.findByRole('alert') // the error surfaced
    expect(onClose).not.toHaveBeenCalled() // NOT closed on a failed save
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

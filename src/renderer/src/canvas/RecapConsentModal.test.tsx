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

  it('Not now → setConsent("declined") + closes', async () => {
    const onClose = vi.fn()
    render(<RecapConsentModal onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /not now/i }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((window as unknown as ApiWindow).api.recap.setConsent).toHaveBeenCalledWith('declined')
  })

  it('renders the privacy assurance text', () => {
    render(<RecapConsentModal onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: /agent recaps/i })
    expect(dialog.textContent).toMatch(/nothing is ever sent to us/i)
  })
})

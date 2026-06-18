// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { OrchestrationConsentModal } from './OrchestrationConsentModal'
import { ToastIsland } from './Toast'
import { useToastStore } from '../store/toastStore'
import { useOrchestrationStore } from '../store/orchestrationStore'

type ApiWindow = { api: { orchestration: { setConsent: ReturnType<typeof vi.fn> } } }

afterEach(cleanup)

describe('OrchestrationConsentModal', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts()
    useOrchestrationStore.setState({ enabled: false, modal: 'enable' })
    ;(window as unknown as ApiWindow).api = {
      orchestration: { setConsent: vi.fn().mockResolvedValue({ ok: true }) }
    }
  })

  it('Enable → setConsent("enabled"), caches enabled, advances to Sync (onEnabled, not onClose)', async () => {
    const onClose = vi.fn()
    const onEnabled = vi.fn()
    render(<OrchestrationConsentModal onClose={onClose} onEnabled={onEnabled} />)
    const dialog = screen.getByRole('dialog', { name: /agent orchestration/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable orchestration/i }))
    await vi.waitFor(() => expect(onEnabled).toHaveBeenCalled())
    expect((window as unknown as ApiWindow).api.orchestration.setConsent).toHaveBeenCalledWith(
      'enabled'
    )
    expect(useOrchestrationStore.getState().enabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled() // grant advances to Sync, not a bare close
  })

  it('Not now → setConsent("declined"), caches disabled, closes', async () => {
    const onClose = vi.fn()
    const onEnabled = vi.fn()
    render(<OrchestrationConsentModal onClose={onClose} onEnabled={onEnabled} />)
    const dialog = screen.getByRole('dialog', { name: /agent orchestration/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /not now/i }))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((window as unknown as ApiWindow).api.orchestration.setConsent).toHaveBeenCalledWith(
      'declined'
    )
    expect(useOrchestrationStore.getState().enabled).toBe(false)
    expect(onEnabled).not.toHaveBeenCalled()
  })

  it('keeps the modal open + shows an error toast when setConsent rejects', async () => {
    ;(window as unknown as ApiWindow).api.orchestration.setConsent.mockRejectedValueOnce(
      new Error('ipc gone')
    )
    const onClose = vi.fn()
    const onEnabled = vi.fn()
    render(
      <>
        <OrchestrationConsentModal onClose={onClose} onEnabled={onEnabled} />
        <ToastIsland />
      </>
    )
    const dialog = screen.getByRole('dialog', { name: /agent orchestration/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable orchestration/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn.t save your choice/i)
    expect(onEnabled).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    const enable = within(dialog).getByRole('button', { name: /enable orchestration/i })
    expect((enable as HTMLButtonElement).disabled).toBe(false) // re-enabled for a retry
  })

  it('keeps the modal open on a resolved {ok:false} (nothing persisted)', async () => {
    ;(window as unknown as ApiWindow).api.orchestration.setConsent.mockResolvedValueOnce({
      ok: false
    })
    const onClose = vi.fn()
    const onEnabled = vi.fn()
    render(
      <>
        <OrchestrationConsentModal onClose={onClose} onEnabled={onEnabled} />
        <ToastIsland />
      </>
    )
    const dialog = screen.getByRole('dialog', { name: /agent orchestration/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable orchestration/i }))
    await screen.findByRole('alert')
    expect(onEnabled).not.toHaveBeenCalled()
    expect(useOrchestrationStore.getState().enabled).toBe(false) // cache untouched on failure
  })

  it('states the load-bearing security invariants (approval gate + cable authorization)', () => {
    render(<OrchestrationConsentModal onClose={vi.fn()} onEnabled={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: /agent orchestration/i })
    expect(dialog.textContent).toMatch(/shown to you for approval/i)
    expect(dialog.textContent).toMatch(/relay along cables you draw/i)
  })

  it('lists all four supported agent CLIs', () => {
    render(<OrchestrationConsentModal onClose={vi.fn()} onEnabled={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: /agent orchestration/i })
    for (const name of ['Claude Code', 'Codex CLI', 'Gemini CLI', 'OpenCode']) {
      expect(within(dialog).getByText(name)).toBeTruthy()
    }
  })

  it('Escape closes without persisting a decision (defers, mirrors recap)', () => {
    const onClose = vi.fn()
    const onEnabled = vi.fn()
    render(<OrchestrationConsentModal onClose={onClose} onEnabled={onEnabled} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect((window as unknown as ApiWindow).api.orchestration.setConsent).not.toHaveBeenCalled()
  })
})

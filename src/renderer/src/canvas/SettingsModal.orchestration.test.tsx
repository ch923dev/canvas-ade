// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useCanvasStore } from '../store/canvasStore'
import { useOrchestrationStore } from '../store/orchestrationStore'

afterEach(cleanup)

const llm = { status: vi.fn(), setKey: vi.fn(), clearKey: vi.fn(), setConfig: vi.fn() }
const recap = { getConsent: vi.fn(), setConsent: vi.fn() }
const orchestration = { getConsent: vi.fn(), setConsent: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  llm.status.mockResolvedValue({
    provider: 'openrouter',
    model: 'm',
    hasKey: false,
    encryptionAvailable: true
  })
  recap.getConsent.mockResolvedValue('undecided')
  recap.setConsent.mockResolvedValue({ ok: true })
  orchestration.getConsent.mockResolvedValue('undecided')
  orchestration.setConsent.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: object }).api = { llm, recap, orchestration }
  useOrchestrationStore.setState({ enabled: false, modal: 'none' })
  useCanvasStore.setState({ project: { dir: '/proj/x', name: 'x', status: 'open' } })
})

describe('SettingsModal — agent orchestration row', () => {
  it('the switch reflects the reactive enabled cache', () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    render(<SettingsModal onClose={() => {}} />)
    const sw = screen.getByRole('switch', { name: /agent orchestration/i })
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the OFF switch closes Settings and re-opens the Enable modal (no direct IPC write)', () => {
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('switch', { name: /agent orchestration/i }))
    expect(useOrchestrationStore.getState().modal).toBe('enable')
    expect(onClose).toHaveBeenCalled() // closes Settings so the modal doesn't stack over it
    expect(orchestration.setConsent).not.toHaveBeenCalled()
  })

  it('clicking the ON switch revokes directly (setConsent declined + caches off)', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    render(<SettingsModal onClose={() => {}} />)
    fireEvent.click(screen.getByRole('switch', { name: /agent orchestration/i }))
    await waitFor(() => expect(orchestration.setConsent).toHaveBeenCalledWith('declined'))
    await waitFor(() => expect(useOrchestrationStore.getState().enabled).toBe(false))
  })

  it('the Sync button closes Settings and opens the Sync modal', () => {
    const onClose = vi.fn()
    render(<SettingsModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^sync$/i }))
    expect(useOrchestrationStore.getState().modal).toBe('sync')
    expect(onClose).toHaveBeenCalled()
  })

  it('disables both controls when no project is open', () => {
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
    render(<SettingsModal onClose={() => {}} />)
    expect(
      (screen.getByRole('switch', { name: /agent orchestration/i }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect((screen.getByRole('button', { name: /^sync$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

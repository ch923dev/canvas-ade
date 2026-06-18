// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { OrchestrationModals } from './OrchestrationModals'
import { useCanvasStore } from '../store/canvasStore'
import { useOrchestrationStore } from '../store/orchestrationStore'

const orchestration = {
  getConsent: vi.fn(),
  setConsent: vi.fn()
}
// The trigger yields to an UNDECIDED recap prompt — default recap to a decided state so the
// orchestration prompt is free to fire in the baseline tests.
const recap = { getConsent: vi.fn() }

afterEach(cleanup)

describe('OrchestrationModals (first-init trigger + hydration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    orchestration.getConsent.mockResolvedValue('undecided')
    orchestration.setConsent.mockResolvedValue({ ok: true })
    recap.getConsent.mockResolvedValue('declined')
    ;(window as unknown as { api: object }).api = { orchestration, recap }
    useOrchestrationStore.setState({ enabled: false, modal: 'none' })
    useCanvasStore.setState({ project: { dir: '/proj/x', name: 'x', status: 'open' } })
  })

  it('opens the Enable modal once when consent is undecided and a project is open', async () => {
    render(<OrchestrationModals />)
    expect(await screen.findByRole('dialog', { name: /agent orchestration/i })).toBeTruthy()
  })

  it('does NOT prompt when consent is already enabled, but hydrates the cache', async () => {
    orchestration.getConsent.mockResolvedValue('enabled')
    render(<OrchestrationModals />)
    await vi.waitFor(() => expect(useOrchestrationStore.getState().enabled).toBe(true))
    expect(screen.queryByRole('dialog', { name: /agent orchestration/i })).toBeNull()
  })

  it('yields to an undecided recap prompt (defers so two first-init modals never stack)', async () => {
    recap.getConsent.mockResolvedValue('undecided')
    render(<OrchestrationModals />)
    await vi.waitFor(() => expect(recap.getConsent).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: /agent orchestration/i })).toBeNull()
    expect(useOrchestrationStore.getState().modal).toBe('none')
  })

  it('does NOT prompt when consent is declined', async () => {
    orchestration.getConsent.mockResolvedValue('declined')
    render(<OrchestrationModals />)
    await vi.waitFor(() => expect(orchestration.getConsent).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: /agent orchestration/i })).toBeNull()
    expect(useOrchestrationStore.getState().enabled).toBe(false)
  })

  it('renders nothing when no project is open (never over a project-less canvas)', async () => {
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
    useOrchestrationStore.setState({ enabled: false, modal: 'enable' })
    const { container } = render(<OrchestrationModals />)
    expect(container.childElementCount).toBe(0)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enable → advances to the Sync step', async () => {
    render(<OrchestrationModals />)
    const dialog = await screen.findByRole('dialog', { name: /agent orchestration/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /enable orchestration/i }))
    expect(await screen.findByRole('dialog', { name: /^sync$/i })).toBeTruthy()
    expect(useOrchestrationStore.getState().modal).toBe('sync')
  })
})

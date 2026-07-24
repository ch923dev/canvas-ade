// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { OrchestrationPane } from './OrchestrationPane'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'
import { useOrchestrationConfigStore } from '../../../store/orchestrationConfigStore'
import { WORKER_SPAWN_CAP } from '../../../store/workerPool'

/**
 * Orchestration pane coverage. The consent row + Sync assertions migrated from the retired
 * `SettingsModal.orchestration.test.tsx`; the worker spawn-cap assertions migrated from
 * `SettingsModal.test.tsx` and were adapted to the reshape: the cap left the LLM Save button and now
 * commits on BLUR here (immediate-apply, matching the toggle), persisting through
 * `orchestrationConfigStore` rather than a modal-wide Save.
 */

afterEach(cleanup)

const orchestration = {
  setConsent: vi.fn(),
  getSpawnCap: vi.fn(),
  setSpawnCap: vi.fn(),
  getLeadStatus: vi.fn(),
  grantLead: vi.fn(),
  revokeLead: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  orchestration.setConsent.mockResolvedValue({ ok: true })
  orchestration.getSpawnCap.mockResolvedValue(WORKER_SPAWN_CAP)
  orchestration.setSpawnCap.mockResolvedValue({ ok: true })
  orchestration.getLeadStatus.mockResolvedValue({ boardId: null })
  orchestration.grantLead.mockResolvedValue({ ok: true })
  orchestration.revokeLead.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: { orchestration: typeof orchestration } }).api = { orchestration }
  useOrchestrationStore.setState({ enabled: false, modal: 'none' })
  // The config cache is a module singleton — reset `loaded` so each test re-fetches getSpawnCap.
  useOrchestrationConfigStore.setState({ spawnCap: WORKER_SPAWN_CAP, loaded: false })
  useCanvasStore.setState({ project: { dir: '/proj/x', name: 'x', status: 'open' } })
})

describe('agent orchestration row', () => {
  it('the switch reflects the reactive enabled cache', () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    render(<OrchestrationPane onClose={() => {}} />)
    const sw = screen.getByRole('switch', { name: /agent orchestration/i })
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the OFF switch closes Settings and re-opens the Enable modal (no direct IPC write)', () => {
    const onClose = vi.fn()
    render(<OrchestrationPane onClose={onClose} />)
    fireEvent.click(screen.getByRole('switch', { name: /agent orchestration/i }))
    expect(useOrchestrationStore.getState().modal).toBe('enable')
    expect(onClose).toHaveBeenCalled() // closes Settings so the modal doesn't stack over it
    expect(orchestration.setConsent).not.toHaveBeenCalled()
  })

  it('clicking the ON switch revokes directly (setConsent declined + caches off)', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    render(<OrchestrationPane onClose={() => {}} />)
    fireEvent.click(screen.getByRole('switch', { name: /agent orchestration/i }))
    await waitFor(() => expect(orchestration.setConsent).toHaveBeenCalledWith('declined'))
    await waitFor(() => expect(useOrchestrationStore.getState().enabled).toBe(false))
  })

  it('the Sync button closes Settings and opens the Sync modal', () => {
    const onClose = vi.fn()
    render(<OrchestrationPane onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^sync$/i }))
    expect(useOrchestrationStore.getState().modal).toBe('sync')
    expect(onClose).toHaveBeenCalled()
  })

  it('disables both controls when no project is open', () => {
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
    render(<OrchestrationPane onClose={() => {}} />)
    expect(
      (screen.getByRole('switch', { name: /agent orchestration/i }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect((screen.getByRole('button', { name: /^sync$/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

describe('worker spawn cap (blur-commit)', () => {
  it('prefills the field from the configured cap', async () => {
    orchestration.getSpawnCap.mockResolvedValue(8)
    render(<OrchestrationPane onClose={() => {}} />)
    const field = (await screen.findByLabelText(/max concurrent workers/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('8'))
  })

  it('persists an edited cap via setSpawnCap when the field blurs', async () => {
    render(<OrchestrationPane onClose={() => {}} />)
    const field = (await screen.findByLabelText(/max concurrent workers/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('4'))
    fireEvent.change(field, { target: { value: '8' } })
    fireEvent.blur(field)
    await waitFor(() => expect(orchestration.setSpawnCap).toHaveBeenCalledWith(8))
    await waitFor(() => expect(field.value).toBe('8'))
  })

  it('snaps a blank/invalid entry back to the stored cap without persisting', async () => {
    render(<OrchestrationPane onClose={() => {}} />)
    const field = (await screen.findByLabelText(/max concurrent workers/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('4'))
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    await waitFor(() => expect(field.value).toBe('4'))
    expect(orchestration.setSpawnCap).not.toHaveBeenCalled()
  })

  it('shows an error and reverts the field when the cap save fails', async () => {
    orchestration.setSpawnCap.mockResolvedValue({ ok: false, reason: 'invalid' })
    render(<OrchestrationPane onClose={() => {}} />)
    const field = (await screen.findByLabelText(/max concurrent workers/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('4'))
    fireEvent.change(field, { target: { value: '8' } })
    fireEvent.blur(field)
    await waitFor(() =>
      expect(
        (document.querySelector('[data-test="settings-orchestration-error"]') as HTMLElement)
          ?.textContent
      ).toMatch(/worker cap/i)
    )
    expect(field.value).toBe('4') // reverted — the store never adopted the rejected value
  })
})

describe('lead terminal (orchestration Phase 1 — consent-gated grant)', () => {
  const seedTerminal = (): void => {
    useCanvasStore.setState({
      boards: [{ id: 't1', type: 'terminal', title: 'Build agent' }] as never
    })
  }

  it('grant is TWO-step: first click arms (Confirm grant), second click calls grantLead', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    seedTerminal()
    render(<OrchestrationPane onClose={() => {}} />)
    const pick = (await screen.findByLabelText(/lead terminal board/i)) as HTMLSelectElement
    fireEvent.change(pick, { target: { value: 't1' } })
    const grant = screen.getByRole('button', { name: /grant lead/i })
    fireEvent.click(grant)
    // Armed — no IPC yet; the button relabels to the explicit confirm.
    expect(orchestration.grantLead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /confirm grant/i }))
    await waitFor(() => expect(orchestration.grantLead).toHaveBeenCalledWith('t1'))
    // On success the section flips to the current-lead row with a Revoke control + restart hint.
    await waitFor(() =>
      expect(document.querySelector('[data-test="settings-lead-current"]')).not.toBeNull()
    )
    expect(
      (document.querySelector('[data-test="settings-lead-note"]') as HTMLElement)?.textContent
    ).toMatch(/restart the agent/i)
  })

  it('changing the selection disarms the pending confirm', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    seedTerminal()
    render(<OrchestrationPane onClose={() => {}} />)
    const pick = (await screen.findByLabelText(/lead terminal board/i)) as HTMLSelectElement
    fireEvent.change(pick, { target: { value: 't1' } })
    fireEvent.click(screen.getByRole('button', { name: /grant lead/i }))
    fireEvent.change(pick, { target: { value: 't1' } })
    // Back to the un-armed label — a fresh two-step is required.
    expect(screen.getByRole('button', { name: /grant lead/i })).toBeTruthy()
    expect(orchestration.grantLead).not.toHaveBeenCalled()
  })

  it('surfaces the single-active-lead refusal (already-active)', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    seedTerminal()
    orchestration.grantLead.mockResolvedValue({
      ok: false,
      reason: 'already-active',
      holder: 't0'
    })
    render(<OrchestrationPane onClose={() => {}} />)
    const pick = (await screen.findByLabelText(/lead terminal board/i)) as HTMLSelectElement
    fireEvent.change(pick, { target: { value: 't1' } })
    fireEvent.click(screen.getByRole('button', { name: /grant lead/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm grant/i }))
    await waitFor(() =>
      expect(
        (document.querySelector('[data-test="settings-lead-note"]') as HTMLElement)?.textContent
      ).toMatch(/already holds the lead role/i)
    )
    expect(document.querySelector('[data-test="settings-lead-current"]')).toBeNull()
  })

  it('hydrates the current lead from getLeadStatus and revokes through revokeLead', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    seedTerminal()
    orchestration.getLeadStatus.mockResolvedValue({ boardId: 't1' })
    render(<OrchestrationPane onClose={() => {}} />)
    await waitFor(() =>
      expect(document.querySelector('[data-test="settings-lead-current"]')).not.toBeNull()
    )
    // Shows the board TITLE, not the raw id.
    expect(
      (document.querySelector('[data-test="settings-lead-current"]') as HTMLElement).textContent
    ).toMatch(/build agent/i)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => expect(orchestration.revokeLead).toHaveBeenCalled())
    await waitFor(() =>
      expect(document.querySelector('[data-test="settings-lead-current"]')).toBeNull()
    )
  })

  it('grant controls are disabled while orchestration consent is off (rides the same consent)', async () => {
    useOrchestrationStore.setState({ enabled: false, modal: 'none' })
    seedTerminal()
    render(<OrchestrationPane onClose={() => {}} />)
    const pick = (await screen.findByLabelText(/lead terminal board/i)) as HTMLSelectElement
    expect(pick.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: /grant lead/i }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

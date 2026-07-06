// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ProjectAgentsPane } from './ProjectAgentsPane'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'

/**
 * Project · Agents pane — the per-project orchestration consent toggle. Mirrors OrchestrationPane's
 * consent-row coverage for the duplicated toggle logic. The load-bearing invariant (this pane's
 * docstring): turning ON must CLOSE Settings first (onClose) before opening the Enable modal, so the
 * two shared Modals never stack.
 */

afterEach(cleanup)

const orchestration = { setConsent: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  orchestration.setConsent.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: { orchestration: typeof orchestration } }).api = { orchestration }
  useOrchestrationStore.setState({ enabled: false, modal: 'none' })
  useCanvasStore.setState({ project: { dir: '/proj/x', name: 'x', status: 'open' } })
})

const sw = (): HTMLButtonElement =>
  screen.getByRole('switch', { name: /agent orchestration/i }) as HTMLButtonElement

describe('project agents pane', () => {
  it('the switch reflects the reactive enabled cache', () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    render(<ProjectAgentsPane onClose={() => {}} />)
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('clicking the OFF switch CLOSES Settings and opens the Enable modal (no direct IPC write)', () => {
    const onClose = vi.fn()
    render(<ProjectAgentsPane onClose={onClose} />)
    fireEvent.click(sw())
    expect(onClose).toHaveBeenCalled() // the invariant: two shared Modals must not stack
    expect(useOrchestrationStore.getState().modal).toBe('enable')
    expect(orchestration.setConsent).not.toHaveBeenCalled()
  })

  it('clicking the ON switch revokes directly (setConsent declined + caches off)', async () => {
    useOrchestrationStore.setState({ enabled: true, modal: 'none' })
    render(<ProjectAgentsPane onClose={() => {}} />)
    fireEvent.click(sw())
    await waitFor(() => expect(orchestration.setConsent).toHaveBeenCalledWith('declined'))
    await waitFor(() => expect(useOrchestrationStore.getState().enabled).toBe(false))
  })

  it('shows the empty state with no project open (no switch)', () => {
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
    render(<ProjectAgentsPane onClose={() => {}} />)
    expect(document.querySelector('[data-test="settings-no-project"]')).not.toBeNull()
    expect(screen.queryByRole('switch', { name: /agent orchestration/i })).toBeNull()
  })
})

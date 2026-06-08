// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { AppChrome } from './AppChrome'
import { useCanvasStore } from '../store/canvasStore'

/**
 * Regression for the recap-consent-modal leak (e2e-terminalio-selection-flake): the
 * per-project consent modal must render ONLY when a project is open. `recap.getConsent`
 * keys off the MAIN current dir while the open-effect keys off the renderer `project.dir`,
 * so the two can desync and leave `askRecap` true with no project open; the render gate
 * (`projectDir !== null`) is what keeps the fixed-position scrim off the canvas. The two
 * cases below differ ONLY in `project.dir` (consent is 'undecided' in both), so they pin the
 * gate itself — dropping it makes the first case render the modal and fail. The e2e matrix
 * covers the cross-spec leak end to end; this is the cheap unit-level anchor.
 */
const getConsent = vi.fn()
beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    project: { recents: vi.fn().mockResolvedValue([]) },
    recap: { getConsent, setConsent: vi.fn().mockResolvedValue({ ok: true }) }
  }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
  getConsent.mockReset()
  // Restore the store's default project so the next test starts clean.
  useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
})

const renderChrome = (): void => {
  render(
    <ReactFlowProvider>
      <AppChrome onTidy={vi.fn()} onFocusGroup={vi.fn()} />
    </ReactFlowProvider>
  )
}

describe('AppChrome recap-consent render gate', () => {
  it('suppresses the modal when consent is undecided but no project is open (dir=null)', async () => {
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'open' } })
    getConsent.mockResolvedValue('undecided')
    renderChrome()
    // Wait past the async getConsent resolution + the (suppressed) setAskRecap(true) it would
    // trigger — without the gate, the modal would have mounted by now.
    await waitFor(() => expect(getConsent).toHaveBeenCalled())
    // Drain microtasks + flush any React re-render queued by setAskRecap (React 18 posts
    // re-renders via a macro-task, so a bare microtask flush could assert before it lands).
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog', { name: /agent recaps/i })).toBeNull()
  })

  it('shows the modal when a project is open and consent is undecided', async () => {
    useCanvasStore.setState({ project: { dir: 'Z:/proj', name: 'proj', status: 'open' } })
    getConsent.mockResolvedValue('undecided')
    renderChrome()
    expect(await screen.findByRole('dialog', { name: /agent recaps/i })).toBeTruthy()
  })

  it('keeps the modal suppressed when a decided project is open (consent declined)', async () => {
    useCanvasStore.setState({ project: { dir: 'Z:/proj', name: 'proj', status: 'open' } })
    getConsent.mockResolvedValue('declined')
    renderChrome()
    await waitFor(() => expect(getConsent).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog', { name: /agent recaps/i })).toBeNull()
  })
})

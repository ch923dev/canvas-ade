// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import SwitchTransitionOverlay from './SwitchTransitionOverlay'
import { armSwitchTransition, clearSwitchTransition } from '../store/switchTransitionStore'
import { performProjectSwitch } from '../store/projectSwitch'
import { useCanvasStore } from '../store/canvasStore'

/**
 * Phase 4c integration (jsdom): the overlay renders on arm, the REAL pipeline drops it
 * immediately on a load error, and the reduced-motion branch skips the dock peek.
 * window.api is a PARTIAL mock — the pipeline's Promise.resolve().then wrappers must
 * degrade its gaps, never throw synchronously (the established integration contract).
 */

const ARM = {
  snapshotUrl: 'data:image/png;base64,AAAA',
  incomingName: 'beta',
  outgoingName: 'alpha'
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    project: {
      save: vi.fn().mockResolvedValue({ ok: true }), // C3: { ok, code? } shape
      captureThumb: vi.fn().mockResolvedValue(true),
      thumb: vi.fn().mockResolvedValue(null),
      closeActive: vi.fn().mockResolvedValue(true)
    }
  }
})

afterEach(() => {
  clearSwitchTransition()
  cleanup()
  delete (window as unknown as { api?: unknown }).api
  vi.unstubAllGlobals()
})

describe('SwitchTransitionOverlay (Phase 4c)', () => {
  it('renders on arm (snapshot + minidock with both cards), unmounts on clear', async () => {
    render(<SwitchTransitionOverlay />)
    expect(screen.queryByTestId('switch-transition')).toBeNull()
    armSwitchTransition(ARM)
    await waitFor(() => expect(screen.getByTestId('switch-transition')).toBeTruthy())
    expect(screen.getByTestId('switch-transition').querySelector('img.st-snapshot')).toBeTruthy()
    expect(screen.getByTestId('st-minidock')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    clearSwitchTransition()
    await waitFor(() => expect(screen.queryByTestId('switch-transition')).toBeNull())
  })

  it('no snapshot ⇒ the HOLD ground with the "Opening <name>…" line (fade path)', async () => {
    render(<SwitchTransitionOverlay />)
    armSwitchTransition({ ...ARM, snapshotUrl: null })
    await waitFor(() => expect(screen.getByText('Opening beta…')).toBeTruthy())
    expect(screen.getByTestId('switch-transition').className).toContain('st-hold')
  })

  it('the REAL pipeline clears the overlay IMMEDIATELY on a load error', async () => {
    render(<SwitchTransitionOverlay />)
    useCanvasStore.setState({ project: { dir: 'C:\\work\\alpha', name: 'alpha', status: 'open' } })
    let resolveLoad!: (v: unknown) => void
    const load = (): Promise<unknown> => new Promise((r) => (resolveLoad = r))
    // keepBackground:false = the explicit harness path (no dialog); the stop-path IPCs the
    // partial mock lacks degrade through their .catch wrappers.
    const p = performProjectSwitch(load, { keepBackground: false, incomingName: 'beta' })
    // Overlay is up mid-switch (thumb() returned null → no snapshot → HOLD ground).
    await waitFor(() => expect(screen.getByTestId('switch-transition')).toBeTruthy())
    resolveLoad({ ok: false, error: 'disk gone' })
    expect(await p).toBe('switched')
    // Error landing → the overlay is ALREADY gone (no IN, no timers) — the error screen
    // (WelcomeScreen with project.error) must be reachable at once.
    expect(screen.queryByTestId('switch-transition')).toBeNull()
    expect(useCanvasStore.getState().project.status).toBe('error')
  })

  it('M1: writes the outgoing session sidecar (saveSession) authoritatively on switch', async () => {
    // Regression: the doc save persists the inline viewport/background, but session.json WINS on
    // the next load (applyLoadedDoc). cancelActiveAutosave() drops the pending sessionSaver, so the
    // switch must write the sidecar itself — else a camera/backdrop change made right before the
    // switch is silently reverted on reopen (the stale session.json overrides the fresh inline copy).
    const saveSession = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { api: { project: Record<string, unknown> } }).api.project.saveSession =
      saveSession
    useCanvasStore.setState({
      project: { dir: 'C:\\work\\alpha', name: 'alpha', status: 'open' },
      viewport: { x: 12, y: 34, zoom: 2 },
      background: {
        kind: 'scene',
        scene: 'blossom-river',
        dim: 0.4,
        saturation: 0.9,
        gridDots: false
      }
    })
    // Load resolves to an error — the switch still reaches saveSession (which runs BEFORE the load),
    // so the assertion holds without needing a full successful open.
    const load = (): Promise<unknown> => Promise.resolve({ ok: false, error: 'stop here' })
    await performProjectSwitch(load, { keepBackground: false, incomingName: 'beta' })
    expect(saveSession).toHaveBeenCalledWith(
      {
        viewport: { x: 12, y: 34, zoom: 2 },
        background: expect.objectContaining({ scene: 'blossom-river' })
      },
      'C:\\work\\alpha'
    )
  })

  it('reduced motion skips the dock peek entirely', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    render(<SwitchTransitionOverlay />)
    armSwitchTransition(ARM)
    await waitFor(() => expect(screen.getByTestId('switch-transition')).toBeTruthy())
    expect(screen.queryByTestId('st-minidock')).toBeNull()
  })
})

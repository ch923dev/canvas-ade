// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { ProjectDock } from './ProjectDock'
import { useCanvasStore } from '../store/canvasStore'

/**
 * Project dock (bg sessions Phase 4b, PHASE4-UX-DESIGN §4) — jsdom integration. The hot
 * zone is driven with window-level pointermove + fake timers (the AppChrome.Dock pattern);
 * data assertions run under real timers via waitFor. window.api is a PARTIAL mock — the
 * component's Promise.resolve().then wrappers must degrade, never throw synchronously.
 * jsdom geometry note: getBoundingClientRect is all-zeros, so once revealed the panel's
 * keep-region resolves to x∈[-32,32] — pointer moves elsewhere count as "left the panel".
 */

const ALPHA = 'C:\\work\\alpha'
const BETA = 'C:\\work\\beta'
const bgBeta = { dir: BETA, name: 'beta', terminalsRunning: 1, previews: 0, backgroundedAt: 5 }

type AnyApi = Record<string, Record<string, ReturnType<typeof vi.fn>>>
let api: AnyApi

beforeEach(() => {
  useCanvasStore.setState({ project: { dir: ALPHA, name: 'alpha', status: 'open' } })
  api = {
    project: {
      listBackground: vi.fn().mockResolvedValue([bgBeta]),
      keepForeverDirs: vi.fn().mockResolvedValue([]),
      askOnSwitchInfo: vi
        .fn()
        .mockResolvedValue({ dir: ALPHA, policy: 'ask', terminals: 2, previews: 0 }),
      captureThumb: vi.fn().mockResolvedValue(true),
      thumbs: vi.fn().mockResolvedValue({}),
      closeBackground: vi.fn().mockResolvedValue(true),
      forgetKeepPolicy: vi.fn().mockResolvedValue(true),
      save: vi.fn().mockResolvedValue(true),
      open: vi.fn().mockResolvedValue({ ok: false, error: 'stub-open' }),
      background: vi.fn().mockResolvedValue({ ok: true, terminals: 1, previews: 0 }),
      closeActive: vi.fn().mockResolvedValue(true),
      recents: vi.fn().mockResolvedValue([{ path: 'C:\\work\\gamma', name: 'gamma' }])
    },
    dialog: { openFolder: vi.fn().mockResolvedValue('C:\\picked\\newproj') }
  }
  ;(window as unknown as { api: unknown }).api = api
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

const moveTo = (clientX: number, clientY: number): void => {
  fireEvent.pointerMove(window, { clientX, clientY })
}
const EDGE_Y = (): number => window.innerHeight - 1

/** Park the pointer on the bottom edge, ride out the intent delay, then real timers. */
const reveal = async (): Promise<void> => {
  vi.useFakeTimers()
  moveTo(400, EDGE_Y())
  act(() => {
    vi.advanceTimersByTime(150)
  })
  vi.useRealTimers()
  await waitFor(() => expect(screen.getByTestId('project-dock')).toBeTruthy())
}

describe('ProjectDock hot zone (bottom edge + intent delay)', () => {
  it('reveals after the pointer parks in the edge zone past the delay', async () => {
    render(<ProjectDock />)
    expect(screen.queryByTestId('project-dock')).toBeNull()
    await reveal()
  })

  it('a drive-by through the edge never opens it', () => {
    vi.useFakeTimers()
    render(<ProjectDock />)
    moveTo(400, EDGE_Y())
    moveTo(400, 100) // exits the zone before the intent delay elapses
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByTestId('project-dock')).toBeNull()
  })

  it('closes after the grace once the pointer leaves the panel region', async () => {
    render(<ProjectDock />)
    vi.useFakeTimers()
    moveTo(400, EDGE_Y())
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.getByTestId('project-dock')).toBeTruthy()
    moveTo(600, 200) // outside the (zero-rect) panel keep-region
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByTestId('project-dock')).toBeNull()
  })

  it('Escape closes the dock', async () => {
    render(<ProjectDock />)
    await reveal()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('project-dock')).toBeNull())
  })
})

describe('ProjectDock membership (session projects ONLY)', () => {
  it('cards = active project (ACTIVE tag + live counts) + backgrounded residents; recents never consulted', async () => {
    render(<ProjectDock />)
    await reveal()
    await waitFor(() => expect(screen.getByText('beta')).toBeTruthy())
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('ACTIVE')).toBeTruthy()
    expect(screen.getByText('2 term')).toBeTruthy() // active counts via askOnSwitchInfo
    expect(screen.getByText('1 term')).toBeTruthy() // resident counts via listBackground
    // Cold recents NEVER appear (§4 locked): the recents IPC is not even called.
    expect(api.project.recents).not.toHaveBeenCalled()
    expect(screen.queryByText('gamma')).toBeNull()
    expect(screen.getAllByTestId('pd-card')).toHaveLength(2)
  })

  it('renders a cached thumbnail as an <img> and the dot-grid placeholder otherwise', async () => {
    const dataUrl = 'data:image/png;base64,QUJD'
    api.project.thumbs.mockResolvedValue({ [BETA]: dataUrl })
    const { container } = render(<ProjectDock />)
    await reveal()
    await waitFor(() => expect(container.querySelector('img.pd-thumb')).toBeTruthy())
    expect(container.querySelector('img.pd-thumb')?.getAttribute('src')).toBe(dataUrl)
    expect(container.querySelector('.pd-thumb-empty')).toBeTruthy() // alpha has no thumb
    // Dock-open is a capture moment for the ACTIVE project (§4) — captureThumb was asked
    // (it degrades to a no-op here: no .react-flow pane in this render).
  })
})

describe('ProjectDock card actions', () => {
  it('clicking a resident card switches through the real pipeline (remembered keep = silent)', async () => {
    api.project.askOnSwitchInfo.mockResolvedValue({
      dir: ALPHA,
      policy: 'keep', // remembered — the switch must ride it with NO dialog
      terminals: 2,
      previews: 0
    })
    render(<ProjectDock />)
    await reveal()
    await waitFor(() => expect(screen.getByLabelText('Switch to beta')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Switch to beta'))
    expect(screen.queryByTestId('project-dock')).toBeNull() // card click closes the dock
    await waitFor(() => expect(api.project.open).toHaveBeenCalledWith(BETA))
    expect(api.project.background).toHaveBeenCalled() // keep path — outgoing parked, not killed
  })

  it('clicking the ACTIVE card just closes the dock (no switch)', async () => {
    render(<ProjectDock />)
    await reveal()
    await waitFor(() => expect(screen.getByLabelText('alpha — active project')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('alpha — active project'))
    expect(screen.queryByTestId('project-dock')).toBeNull()
    expect(api.project.open).not.toHaveBeenCalled()
  })

  it('✕ on a RUNNING resident opens the shared §3 confirm; confirm disposes', async () => {
    render(<ProjectDock />)
    await reveal()
    await waitFor(() => expect(screen.getByLabelText('Close background project beta')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Close background project beta'))
    await waitFor(() => expect(screen.getByTestId('close-bg-modal')).toBeTruthy())
    expect(api.project.closeBackground).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('close-bg-confirm'))
    await waitFor(() => expect(api.project.closeBackground).toHaveBeenCalledWith(BETA))
  })

  it('✕ on an IDLE resident closes silently — no modal', async () => {
    api.project.listBackground.mockResolvedValue([{ ...bgBeta, terminalsRunning: 0, previews: 0 }])
    render(<ProjectDock />)
    await reveal()
    await waitFor(() => expect(screen.getByLabelText('Close background project beta')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Close background project beta'))
    await waitFor(() => expect(api.project.closeBackground).toHaveBeenCalledWith(BETA))
    expect(screen.queryByTestId('close-bg-modal')).toBeNull()
  })

  it('∞ forgets the keep policy (sessions untouched)', async () => {
    api.project.keepForeverDirs.mockResolvedValue([BETA])
    render(<ProjectDock />)
    await reveal()
    await waitFor(() =>
      expect(screen.getByLabelText('Stop always keeping beta in the background')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('Stop always keeping beta in the background'))
    await waitFor(() => expect(api.project.forgetKeepPolicy).toHaveBeenCalledWith(BETA))
    expect(api.project.closeBackground).not.toHaveBeenCalled()
  })

  it('+ tile reuses the switcher flows: Open folder… → dialog → project.open', async () => {
    // Idle outgoing (counts 0) so the pipeline takes the silent stop path — no dialog store.
    api.project.askOnSwitchInfo.mockResolvedValue({
      dir: ALPHA,
      policy: 'ask',
      terminals: 0,
      previews: 0
    })
    render(<ProjectDock />)
    await reveal()
    fireEvent.click(screen.getByTestId('pd-plus'))
    await waitFor(() => expect(screen.getByText('Open folder…')).toBeTruthy())
    fireEvent.click(screen.getByText('Open folder…'))
    await waitFor(() => expect(api.dialog.openFolder).toHaveBeenCalled())
    await waitFor(() => expect(api.project.open).toHaveBeenCalledWith('C:\\picked\\newproj'))
    expect(screen.queryByTestId('project-dock')).toBeNull() // picked → dock closed
  })
})

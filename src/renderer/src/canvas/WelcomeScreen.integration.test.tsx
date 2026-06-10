// @vitest-environment jsdom
/**
 * Regression tests for WelcomeScreen bugs:
 *   BUG-008 — no busy guard allows concurrent openDir calls to race and corrupt canvas state
 *   BUG-030 — openDir() leaves status stuck at 'loading' if the IPC call rejects
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import WelcomeScreen from './WelcomeScreen'
import {
  useCanvasStore,
  acquireProjectSwitchLock,
  releaseProjectSwitchLock
} from '../store/canvasStore'

// Reset the Zustand store to a known welcome state before each test.
beforeEach(() => {
  useCanvasStore.setState({
    project: { dir: null, name: null, status: 'welcome' }
  })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
  // BUG-009 lock is module state: a test whose open IPC deliberately never settles (the
  // disabled-buttons probe) would otherwise strand it held for every later test.
  releaseProjectSwitchLock()
})

// ---------------------------------------------------------------------------
// BUG-008: concurrent openDir calls must be blocked by a busy guard
// ---------------------------------------------------------------------------
describe('WelcomeScreen busy guard (BUG-008)', () => {
  it('a second openDir call while first is in-flight does NOT start a second IPC call', async () => {
    // Arrange: two recent projects; open IPC resolves immediately but on a microtask so we can
    // fire both clicks before either resolves.
    let resolveFirst!: (v: unknown) => void
    const openMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res
          })
      )
      // Second implementation (should never be reached if the guard works).
      .mockImplementationOnce(() => Promise.resolve({ ok: false, error: 'should not be called' }))

    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue([
          { path: '/proj/alpha', name: 'alpha' },
          { path: '/proj/beta', name: 'beta' }
        ]),
        open: openMock
      },
      dialog: { openFolder: vi.fn() }
    }

    render(<WelcomeScreen />)

    // Wait for the recents list to load.
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())

    const alphaBtn = screen.getByText('alpha').closest('button')!
    const betaBtn = screen.getByText('beta').closest('button')!

    // Click alpha — first IPC call fires, status becomes 'loading'.
    fireEvent.click(alphaBtn)
    // At this point status should now be 'loading'.
    await waitFor(() => expect(useCanvasStore.getState().project.status).toBe('loading'))

    // Click beta immediately (before the first IPC call resolves) — the busy guard
    // must block this second openDir call. With BUG-008 present, openMock would be
    // called a second time.
    fireEvent.click(betaBtn)

    // Resolve the first IPC call (the only one that should have been started).
    await act(async () => {
      resolveFirst({
        ok: true,
        doc: { schemaVersion: 1, boards: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } },
        dir: '/proj/alpha',
        name: 'alpha'
      })
    })

    // The guard must have blocked the second call — openMock should only be called once.
    expect(openMock).toHaveBeenCalledTimes(1)
    expect(openMock).toHaveBeenCalledWith('/proj/alpha')
  })

  it('buttons are visually disabled while a project is loading', async () => {
    // Arrange: IPC never resolves (simulates in-flight call).
    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue([{ path: '/proj/alpha', name: 'alpha' }]),
        open: vi.fn().mockImplementation(() => new Promise(() => {})) // never resolves
      },
      dialog: { openFolder: vi.fn() }
    }

    render(<WelcomeScreen />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())

    const alphaBtn = screen.getByText('alpha').closest('button')!
    fireEvent.click(alphaBtn)

    await waitFor(() => expect(useCanvasStore.getState().project.status).toBe('loading'))

    // After the first click the buttons must be disabled.
    expect((alphaBtn as HTMLButtonElement).disabled).toBe(true)
    const openBtn = screen.getByText('Open folder…')
    expect((openBtn as HTMLButtonElement).disabled).toBe(true)
    const createBtn = screen.getByText('Create project…')
    expect((createBtn as HTMLButtonElement).disabled).toBe(true)
  })

  // BUG-009: the per-mount busy flag cannot see a switch started from the ProjectSwitcher
  // (this screen mounts FRESH mid-switch with busy=false). The shared module-level lock
  // must block openDir while another surface's switch pipeline is in flight.
  it('an in-flight switch from another surface blocks openDir (BUG-009 shared lock)', async () => {
    const openMock = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue([{ path: '/proj/alpha', name: 'alpha' }]),
        open: openMock
      },
      dialog: { openFolder: vi.fn() }
    }

    render(<WelcomeScreen />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())

    // Simulate a ProjectSwitcher switch mid-flight: it holds the module lock.
    expect(acquireProjectSwitchLock()).toBe(true)
    fireEvent.click(screen.getByText('alpha').closest('button')!)
    await act(async () => {}) // flush microtasks

    // openDir must bail BEFORE firing the IPC or touching project state.
    expect(openMock).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().project.status).toBe('welcome')
  })
})

// ---------------------------------------------------------------------------
// BUG-030: rejected IPC call must not leave status stuck at 'loading'
// ---------------------------------------------------------------------------
describe('WelcomeScreen IPC rejection recovery (BUG-030)', () => {
  it('settles to status:error when project.open IPC rejects (not stuck at loading)', async () => {
    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue([{ path: '/proj/alpha', name: 'alpha' }]),
        open: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device'))
      },
      dialog: { openFolder: vi.fn() }
    }

    render(<WelcomeScreen />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())

    fireEvent.click(screen.getByText('alpha').closest('button')!)

    // Must NOT stay at 'loading'; must transition to 'error'.
    await waitFor(() => {
      const status = useCanvasStore.getState().project.status
      expect(status).toBe('error')
    })
    expect(useCanvasStore.getState().project.status).not.toBe('loading')
    expect(useCanvasStore.getState().project.error).toContain('no space left')
  })

  it('settles to status:error when project.create IPC rejects (not stuck at loading)', async () => {
    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockRejectedValue(new Error('EACCES: permission denied'))
      },
      dialog: { openFolder: vi.fn().mockResolvedValue('/proj/new') }
    }

    render(<WelcomeScreen />)

    fireEvent.click(screen.getByText('Create project…'))

    await waitFor(() => {
      expect(useCanvasStore.getState().project.status).toBe('error')
    })
    expect(useCanvasStore.getState().project.status).not.toBe('loading')
    expect(useCanvasStore.getState().project.error).toContain('permission denied')
  })

  it('shows the error banner in the UI after IPC rejection', async () => {
    ;(window as unknown as { api: unknown }).api = {
      project: {
        recents: vi.fn().mockResolvedValue([{ path: '/proj/alpha', name: 'alpha' }]),
        open: vi.fn().mockRejectedValue(new Error('ENOSPC: disk full'))
      },
      dialog: { openFolder: vi.fn() }
    }

    render(<WelcomeScreen />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())

    fireEvent.click(screen.getByText('alpha').closest('button')!)

    // After rejection the error banner must appear in the rendered UI.
    await waitFor(() => {
      expect(screen.queryByText(/Could not open project/)).not.toBeNull()
    })
  })
})

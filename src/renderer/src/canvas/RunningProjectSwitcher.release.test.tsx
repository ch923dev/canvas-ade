// @vitest-environment jsdom
/**
 * R16 — commit-on-release, at the surface that actually commits.
 *
 * The store half (`runningSwitcherStore.test.ts`) proves the hold is recorded even when the
 * release beats the overlay's async snapshot fetch. This file proves the other half: that an OPEN
 * overlay seeing a released hold runs the REAL switch pipeline, and — just as important — that
 * nothing else does. A commit-on-release that also fired on a stray keyup, on the active card, or
 * after Esc would be a project switch the user never asked for, which is the most destructive
 * possible failure of this feature (it tears down and re-mounts every board).
 *
 * The whole keyboard journey is exercised through the same two seams production uses: the store's
 * `noteHoldKey` / `noteHoldReleased` (fed by `useProjectSwitchHotkey`'s window listener) and a real
 * DOM `keyup`, so nothing here is a private back door.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { RunningProjectSwitcher } from './RunningProjectSwitcher'
import { useRunningSwitcherStore } from '../store/runningSwitcherStore'
import { useProjectSwitchHotkey } from '../store/useProjectSwitchHotkey'
import type { ProjectDockCard } from './projectSessionsShared'

const performProjectSwitch = vi.hoisted(() =>
  vi.fn<(load: () => Promise<unknown>, opts?: { incomingName?: string }) => Promise<string>>()
)
vi.mock('../store/projectSwitch', () => ({
  // The real pipeline is out of scope here (it has its own 31-case file) — but the load thunk is
  // invoked for real, so the test still proves WHICH project the commit reached for.
  performProjectSwitch: (load: () => Promise<unknown>, opts?: { incomingName?: string }) => {
    void load()
    return performProjectSwitch(load, opts)
  }
}))

const card = (dir: string, active = false): ProjectDockCard => ({
  dir,
  name: dir.split('/').pop() as string,
  terminalsRunning: active ? 0 : 1,
  previews: 0,
  active
})

const CARDS = [card('C:/active', true), card('C:/resident')]

/** `project.open` — typed loosely and cast at the assignment below, since this test stubs only the
 *  two `window.api.project` members the overlay actually touches. */
const open = vi.fn<(dir: string) => Promise<{ ok: boolean }>>()

/** Mounts the overlay together with the hook that owns the keyup listener — the real pairing. */
function Harness(): React.ReactElement {
  useProjectSwitchHotkey()
  return <RunningProjectSwitcher />
}

/**
 * Put the overlay up exactly as a hotkey interaction leaves it: snapshot frozen, hold armed.
 * Wrapped in `act` because the overlay's keyboard-nav listener is registered by an effect gated on
 * `open` — without a flush, a keydown dispatched on the next line lands before that listener
 * exists and the test would be asserting against an overlay that isn't listening yet.
 */
function openWithHold(index = 1, holdKey: 'Control' | 'Meta' | 'Alt' | null = 'Control'): void {
  act(() => {
    useRunningSwitcherStore.setState({
      open: true,
      cards: CARDS,
      index,
      holdKey,
      holdReleased: false
    })
  })
}

beforeEach(() => {
  useRunningSwitcherStore.setState({
    open: false,
    cards: [],
    index: 0,
    holdKey: null,
    holdReleased: false
  })
  performProjectSwitch.mockReset().mockResolvedValue('switched')
  open.mockReset().mockResolvedValue({ ok: true })
  ;(globalThis as unknown as { window: Window & { api: unknown } }).window.api = {
    project: { open, thumb: vi.fn().mockResolvedValue(null) }
  } as never
})

afterEach(cleanup)

describe('commit-on-release (R16)', () => {
  it('releasing the held modifier switches to the highlighted project', async () => {
    render(<Harness />)
    openWithHold(1)

    // The real event the hook listens for — not a direct store poke.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })

    expect(performProjectSwitch).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('C:/resident')
    expect(performProjectSwitch.mock.calls[0][1]).toEqual({ incomingName: 'resident' })
    // The overlay gets out of the way immediately; it does not linger through the pipeline.
    expect(useRunningSwitcherStore.getState().open).toBe(false)
  })

  it('an overlay that opens ALREADY released commits at once (the fast-tap case)', async () => {
    render(<Harness />)
    // The tap let go while the snapshot was still being fetched, so the overlay's first render
    // is also its last. This is the commonest Alt-Tab gesture there is, not an edge case.
    await act(async () => {
      useRunningSwitcherStore.setState({
        open: true,
        cards: CARDS,
        index: 1,
        holdKey: 'Control',
        holdReleased: true
      })
    })

    expect(performProjectSwitch).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('C:/resident')
  })

  it('releasing on the ACTIVE card dismisses without switching', async () => {
    render(<Harness />)
    openWithHold(0)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })

    // Alt-Tab parity: letting go on the window you are already in does nothing.
    expect(performProjectSwitch).not.toHaveBeenCalled()
    expect(useRunningSwitcherStore.getState().open).toBe(false)
  })

  it('releasing a DIFFERENT key does not commit', async () => {
    render(<Harness />)
    openWithHold(1)

    await act(async () => {
      // Alt is part of the default chord but is NOT the hold — only Ctrl/Cmd commits.
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }))
    })

    expect(performProjectSwitch).not.toHaveBeenCalled()
    expect(useRunningSwitcherStore.getState().open).toBe(true)
  })

  it('Esc cancels, and the later release of the modifier does NOT then fire a switch', async () => {
    render(<Harness />)
    openWithHold(1)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useRunningSwitcherStore.getState().open).toBe(false)

    // The user is still physically holding Ctrl when they hit Esc; letting go afterwards must not
    // resurrect the switch they just cancelled.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })
    expect(performProjectSwitch).not.toHaveBeenCalled()
  })

  it('a stray keyup with the overlay closed never switches anything', async () => {
    render(<Harness />)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })

    expect(performProjectSwitch).not.toHaveBeenCalled()
    expect(useRunningSwitcherStore.getState().open).toBe(false)
  })

  it('commits ONCE even if the modifier keyup repeats', async () => {
    render(<Harness />)
    openWithHold(1)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })

    expect(performProjectSwitch).toHaveBeenCalledTimes(1)
  })

  it('commits the CURRENT highlight, including one moved after the overlay opened', async () => {
    render(<Harness />)
    openWithHold(0)

    await act(async () => {
      // Tab onto the resident, then let go.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })

    expect(open).toHaveBeenCalledWith('C:/resident')
  })

  it('Enter still commits explicitly (release is added, not substituted)', async () => {
    render(<Harness />)
    openWithHold(1)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })

    expect(performProjectSwitch).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('C:/resident')
  })
})

describe('the footer teaches the gesture (R16 design sign-off)', () => {
  it('names the release first, sharing one "open" cell with Enter', () => {
    const { container } = render(<Harness />)
    openWithHold(1)

    const foot = container.querySelector('.rps-foot')?.textContent ?? ''
    expect(foot).toContain('release')
    expect(foot).toContain('Ctrl')
    // One "open", not two — the reason release and Enter share a cell.
    expect(foot.match(/open/g) ?? []).toHaveLength(1)
  })

  it('spells the hold as ⌘ when the bound chord is Cmd', () => {
    const { container } = render(<Harness />)
    openWithHold(1, 'Meta')
    expect(container.querySelector('.rps-foot')?.textContent).toContain('⌘')
  })

  it('a modifier-free rebind keeps the original Enter-only hint', () => {
    const { container } = render(<Harness />)
    openWithHold(1, null)

    const foot = container.querySelector('.rps-foot')?.textContent ?? ''
    // Nothing is being held, so promising a release that commits would be a lie.
    expect(foot).not.toContain('release')
    expect(foot).toContain('open')
  })
})

/**
 * lifecycleNotifications.ts — the ONE delivery site (audit P1-3: this module had ZERO unit
 * coverage while holding the gate wiring, the OS-raise, the click closure, and the
 * window-destroyed guards; every P1/P2 fix in the 2026-07-31 audit lives here).
 *
 * Electron is fully mocked (backgroundSessions.test.ts precedent), plus `./pty` (would drag
 * node-pty into a node run via setPtyLifecycleEmitter) and `./boardRegistry`. Most of the matrix
 * drives `createLifecycleDeliver` directly with injected deps — no electron needed; the
 * `defaultOsNotify` / wiring cases go through `registerLifecycleNotifications` with the
 * Claude-path notifier stubbed to capture `onEvent`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NotificationsConfig } from './notificationsConfig'

const h = vi.hoisted(() => ({
  notificationCtor: vi.fn(),
  notificationShow: vi.fn(),
  notificationOnClick: null as (() => void) | null,
  notificationSupported: true,
  notificationThrow: false,
  onceBeforeQuit: vi.fn(),
  notifierOnEvent: null as ((sig: unknown) => void) | null,
  notifierDispose: vi.fn()
}))

vi.mock('electron', () => ({
  app: { once: (...a: unknown[]) => h.onceBeforeQuit(...(a as [])) },
  ipcMain: { handle: vi.fn() },
  Notification: Object.assign(
    class {
      constructor(opts: unknown) {
        if (h.notificationThrow) throw new Error('toast registration failed')
        h.notificationCtor(opts)
      }
      on(_ev: string, cb: () => void): void {
        h.notificationOnClick = cb
      }
      show(): void {
        h.notificationShow()
      }
    },
    { isSupported: () => h.notificationSupported }
  )
}))

vi.mock('./pty', () => ({ setPtyLifecycleEmitter: vi.fn() }))
vi.mock('./boardRegistry', () => ({ listBoardMirror: vi.fn(() => []) }))
vi.mock('./agentLifecycle', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agentLifecycle')>()
  return {
    ...real,
    createLifecycleNotifier: (deps: { onEvent: (sig: unknown) => void }) => {
      h.notifierOnEvent = deps.onEvent
      return h.notifierDispose
    }
  }
})

import {
  createLifecycleDeliver,
  registerLifecycleNotifications,
  type LifecycleDeliverDeps
} from './lifecycleNotifications'
import { resetPendingNotify, drainPendingNotify } from './notifyQueue'

const CONFIG_ON: NotificationsConfig = {
  enabled: true,
  onDone: true,
  onInput: true,
  onError: true,
  onlyWhenUnfocused: false
}

interface FakeWin {
  win: {
    isDestroyed: () => boolean
    isFocused: () => boolean
    isMinimized: () => boolean
    restore: () => void
    show: () => void
    focus: () => void
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  }
  send: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

function fakeWin(opts?: {
  destroyed?: boolean
  focused?: boolean
  minimized?: boolean
  wcDestroyed?: boolean
}): FakeWin {
  const send = vi.fn()
  const restore = vi.fn()
  const show = vi.fn()
  const focus = vi.fn()
  return {
    win: {
      isDestroyed: () => opts?.destroyed ?? false,
      isFocused: () => opts?.focused ?? false,
      isMinimized: () => opts?.minimized ?? false,
      restore,
      show,
      focus,
      webContents: { isDestroyed: () => opts?.wcDestroyed ?? false, send }
    },
    send,
    restore,
    show,
    focus
  }
}

function makeDeliver(over?: Partial<LifecycleDeliverDeps> & { win?: FakeWin | null }): {
  deliver: (sig: Parameters<ReturnType<typeof createLifecycleDeliver>>[0]) => void
  raise: ReturnType<typeof vi.fn>
  w: FakeWin | null
  ensureWindow: ReturnType<typeof vi.fn>
} {
  const w = over && 'win' in over ? (over.win ?? null) : fakeWin()
  const raise = vi.fn()
  const ensureWindow = vi.fn()
  const deliver = createLifecycleDeliver({
    getWin: () => (w ? (w.win as never) : null),
    getConfig: () => CONFIG_ON,
    getBoard: () => undefined,
    raise,
    ensureWindow,
    ...over
  })
  return { deliver, raise, w, ensureWindow }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.notificationSupported = true
  h.notificationThrow = false
  h.notificationOnClick = null
  h.notifierOnEvent = null
  resetPendingNotify()
})

describe('gate outcomes', () => {
  it('master off ⇒ fully silent (no raise, no send, and no dedupe poisoning)', () => {
    const { deliver, raise, w } = makeDeliver({
      getConfig: () => ({ ...CONFIG_ON, enabled: false })
    })
    deliver({ boardId: 'b', event: 'done' })
    expect(raise).not.toHaveBeenCalled()
    expect(w!.send).not.toHaveBeenCalled()
  })

  it('a silenced attempt does NOT poison the dedupe window (gate first, dedupe second)', () => {
    let enabled = false
    const { deliver, raise } = makeDeliver({ getConfig: () => ({ ...CONFIG_ON, enabled }) })
    deliver({ boardId: 'b', event: 'done' })
    enabled = true
    deliver({ boardId: 'b', event: 'done' })
    expect(raise).toHaveBeenCalledTimes(1)
  })

  it('board monitorActivity:false ⇒ fully silent; ABSENT board defaults to monitored', () => {
    const { deliver, raise } = makeDeliver({
      getBoard: () => ({ monitorActivity: false })
    })
    deliver({ boardId: 'muted', event: 'done' })
    expect(raise).not.toHaveBeenCalled()

    const open = makeDeliver({ getBoard: () => undefined })
    open.deliver({ boardId: 'unknown', event: 'done' })
    expect(open.raise).toHaveBeenCalledTimes(1)
  })

  it('onlyWhenUnfocused + focused ⇒ OS suppressed but the renderer push still fires', () => {
    const w = fakeWin({ focused: true })
    const { deliver, raise } = makeDeliver({
      win: w,
      getConfig: () => ({ ...CONFIG_ON, onlyWhenUnfocused: true })
    })
    deliver({ boardId: 'b', event: 'done' })
    expect(raise).not.toHaveBeenCalled()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it('isWindowFocused override wins over the real win.isFocused()', () => {
    const w = fakeWin({ focused: false })
    const { deliver, raise } = makeDeliver({
      win: w,
      getConfig: () => ({ ...CONFIG_ON, onlyWhenUnfocused: true }),
      isWindowFocused: () => true
    })
    deliver({ boardId: 'b', event: 'done' })
    expect(raise).not.toHaveBeenCalled()
  })
})

describe('payload discipline', () => {
  it('a pre-P4 signal produces a byte-identical payload — exactly {boardId, event}', () => {
    const { deliver, w } = makeDeliver()
    deliver({ boardId: 'b', event: 'done' })
    const payload = w!.send.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(payload)).toEqual(['boardId', 'event'])
  })

  it('attention + detail ride out when present', () => {
    const { deliver, w } = makeDeliver()
    deliver({ boardId: 'b', event: 'needs-input', attention: 'blocked', detail: 'silent 11m' })
    expect(w!.send).toHaveBeenCalledWith('notify:lifecycle', {
      boardId: 'b',
      event: 'needs-input',
      attention: 'blocked',
      detail: 'silent 11m'
    })
  })

  it('OS body carries basename(cwd); absent cwd falls back to the click hint', () => {
    const { deliver, raise } = makeDeliver({
      getBoard: () => ({ title: 'My board', agentKind: 'claude' })
    })
    deliver({ boardId: 'b', event: 'done', cwd: 'C:/repos/proj' })
    expect(raise.mock.calls[0][0]).toMatchObject({
      title: 'Task done — claude',
      body: 'My board · proj'
    })
    // No board facts + no cwd ⇒ the click-hint fallback.
    const bare = makeDeliver()
    bare.deliver({ boardId: 'b2', event: 'done' })
    expect(bare.raise.mock.calls[0][0]).toMatchObject({ body: 'Click to open the board' })
  })
})

describe('deliver dedupe (audit P2-2)', () => {
  it('the hook-vs-idle double needs-input collapses to ONE delivery', () => {
    const { deliver, raise, w } = makeDeliver()
    deliver({ boardId: 'b', event: 'needs-input' }) // Claude hook path
    deliver({ boardId: 'b', event: 'needs-input' }) // idle monitor, ~same instant
    expect(raise).toHaveBeenCalledTimes(1)
    expect(w!.send).toHaveBeenCalledTimes(1)
  })

  it('a re-block with a NEW detail still fires (commandFeed legitimate re-fire)', () => {
    const { deliver, raise } = makeDeliver()
    deliver({ boardId: 'b', event: 'needs-input', attention: 'blocked', detail: 'silent 11m' })
    deliver({ boardId: 'b', event: 'needs-input', attention: 'blocked', detail: 'failing check' })
    expect(raise).toHaveBeenCalledTimes(2)
  })

  it('tray done events on DIFFERENT boards never collapse', () => {
    const { deliver, raise } = makeDeliver()
    deliver({ boardId: 's1', event: 'done' })
    deliver({ boardId: 's2', event: 'done' })
    expect(raise).toHaveBeenCalledTimes(2)
  })

  it('the same board re-completes after the window ⇒ fires again', () => {
    let t = 0
    const { deliver, raise } = makeDeliver({ now: () => t })
    deliver({ boardId: 'b', event: 'done' })
    t += 10_000
    deliver({ boardId: 'b', event: 'done' })
    expect(raise).toHaveBeenCalledTimes(2)
  })
})

describe('dead-window behavior (audit P1-1 / P2-3)', () => {
  it('renderer push with no window ⇒ ENQUEUED, not dropped', () => {
    const { deliver, raise } = makeDeliver({ win: null })
    deliver({ boardId: 'b', event: 'done', attention: 'done' })
    expect(raise).toHaveBeenCalledTimes(1) // OS layer still raises (tray case)
    const pending = drainPendingNotify()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      t: 'lifecycle',
      payload: { boardId: 'b', event: 'done', attention: 'done' }
    })
  })

  it('destroyed webContents ⇒ enqueued too', () => {
    const w = fakeWin({ wcDestroyed: true })
    const { deliver } = makeDeliver({ win: w })
    deliver({ boardId: 'b', event: 'done' })
    expect(w.send).not.toHaveBeenCalled()
    expect(drainPendingNotify()).toHaveLength(1)
  })

  it('live window ⇒ nothing enqueued', () => {
    const { deliver } = makeDeliver()
    deliver({ boardId: 'b', event: 'done' })
    expect(drainPendingNotify()).toEqual([])
  })
})

describe('OS-click closure', () => {
  function clickAfterDeliver(w: FakeWin | null): {
    raise: ReturnType<typeof vi.fn>
    ensureWindow: ReturnType<typeof vi.fn>
    w: FakeWin | null
  } {
    const made = makeDeliver({ win: w })
    made.deliver({ boardId: 'b', event: 'done' })
    const onClick = (made.raise.mock.calls[0][0] as { onClick: () => void }).onClick
    onClick()
    return { raise: made.raise, ensureWindow: made.ensureWindow, w: made.w }
  }

  it('live window: restore-if-minimized → show → focus → notify:focusBoard', () => {
    const w = fakeWin({ minimized: true })
    clickAfterDeliver(w)
    expect(w.restore).toHaveBeenCalled()
    expect(w.show).toHaveBeenCalled()
    expect(w.focus).toHaveBeenCalled()
    expect(w.send).toHaveBeenCalledWith('notify:focusBoard', { boardId: 'b' })
  })

  it('dead window: enqueues the focus intent and calls ensureWindow ONCE (audit P1-1)', () => {
    const { ensureWindow } = clickAfterDeliver(null)
    expect(ensureWindow).toHaveBeenCalledTimes(1)
    const pending = drainPendingNotify().filter((p) => p.t === 'focus')
    expect(pending).toEqual([{ t: 'focus', at: expect.any(Number), boardId: 'b' }])
  })

  it('dead window with NO ensureWindow dep: no throw (the e2e probe shape)', () => {
    const raise = vi.fn()
    const deliver = createLifecycleDeliver({
      getWin: () => null,
      getConfig: () => CONFIG_ON,
      getBoard: () => undefined,
      raise
    })
    deliver({ boardId: 'b', event: 'done' })
    const onClick = (raise.mock.calls[0][0] as { onClick: () => void }).onClick
    expect(() => onClick()).not.toThrow()
  })
})

describe('registerLifecycleNotifications (defaultOsNotify + wiring)', () => {
  function wire(win: FakeWin | null): { deliverSig: (sig: unknown) => void } {
    registerLifecycleNotifications({
      mapPath: 'C:/userData/recap/session-map.jsonl',
      getWin: () => (win ? (win.win as never) : null),
      getConfig: () => CONFIG_ON,
      getBoard: () => undefined
    })
    return { deliverSig: (sig) => h.notifierOnEvent!(sig) }
  }

  it('routes the Claude-path notifier into deliver and raises a REAL (mocked) Notification', () => {
    const w = fakeWin()
    wire(w).deliverSig({ boardId: 'b', event: 'done', cwd: 'C:/x' })
    expect(h.notificationCtor).toHaveBeenCalledTimes(1)
    expect(h.notificationShow).toHaveBeenCalledTimes(1)
    expect(w.send).toHaveBeenCalledWith('notify:lifecycle', { boardId: 'b', event: 'done' })
  })

  it('a throwing Notification ctor is swallowed — the renderer push STILL fires (audit P2-4)', () => {
    h.notificationThrow = true
    const w = fakeWin()
    expect(() => wire(w).deliverSig({ boardId: 'b', event: 'done' })).not.toThrow()
    expect(w.send).toHaveBeenCalledWith('notify:lifecycle', { boardId: 'b', event: 'done' })
  })

  it('Notification.isSupported() false ⇒ silent OS no-op, renderer push unaffected', () => {
    h.notificationSupported = false
    const w = fakeWin()
    wire(w).deliverSig({ boardId: 'b', event: 'done' })
    expect(h.notificationCtor).not.toHaveBeenCalled()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it('registers the before-quit disposer and returns {dispose, deliver}', () => {
    const handle = registerLifecycleNotifications({
      mapPath: 'C:/userData/recap/session-map.jsonl',
      getWin: () => null,
      getConfig: () => CONFIG_ON,
      getBoard: () => undefined
    })
    expect(typeof handle.dispose).toBe('function')
    expect(typeof handle.deliver).toBe('function')
    expect(h.onceBeforeQuit).toHaveBeenCalledWith('before-quit', h.notifierDispose)
  })
})

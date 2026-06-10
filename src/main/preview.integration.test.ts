import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import { shell } from 'electron'
import { registerPreviewHandlers } from './preview'
import { createIpcCapture, foreignEvent, internalEvent, mainWin } from './ipcTestHarness'

// ── Electron mock ──────────────────────────────────────────────────────────────
// Vitest runs outside the Electron runtime, so `require('electron')` returns a
// bare string (the binary path). We stub the surface preview.ts actually uses:
// WebContentsView (with a session stub) and shell. The session spy-handles let
// the permission-handler tests capture and exercise the installed callbacks.
// Hoisted so the factory runs before the `import { registerPreviewHandlers }`
// above resolves its `import { WebContentsView, shell } from 'electron'`.
const { makeSessionSpies, createdViews } = vi.hoisted(() => {
  // Build fresh session spies per test so calls don't bleed between tests.
  function makeSessionSpies(): {
    setPermissionRequestHandler: ReturnType<typeof vi.fn>
    setPermissionCheckHandler: ReturnType<typeof vi.fn>
  } {
    return {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    }
  }
  // Every WebContentsView instance the mock constructor creates, in creation order,
  // so tests can reach a view's spies (close, setWindowOpenHandler). Reset per test.
  const createdViews: Array<{
    webContents: { close: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn> }
  }> = []
  return { makeSessionSpies, createdViews }
})

// We need one shared spy reference per view creation — the factory below captures
// the latest spy set so each WebContentsView constructor uses fresh spies that
// the test can inspect.
let _currentSessionSpies: ReturnType<typeof makeSessionSpies> | null = null

vi.mock('electron', () => {
  // Minimal WebContentsView stub: creates a fake view + webContents with a fake session
  // and the subset of APIs that preview.ts wires up in ensure() and attach().
  class WebContentsView {
    webContents: {
      session: ReturnType<typeof makeSessionSpies>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      getURL: () => string
      setZoomFactor: ReturnType<typeof vi.fn>
      navigationHistory: { canGoBack: () => boolean; canGoForward: () => boolean }
      loadURL: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      id: number
    }
    setVisible: ReturnType<typeof vi.fn>
    setBounds: ReturnType<typeof vi.fn>

    constructor() {
      // Use the most-recently-created session spies (reset per test by beforeEach).
      const sess = _currentSessionSpies ?? makeSessionSpies()
      this.webContents = {
        session: sess,
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        getURL: () => 'http://localhost:5173/',
        setZoomFactor: vi.fn(),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        loadURL: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        id: 42
      }
      this.setVisible = vi.fn()
      this.setBounds = vi.fn()
      createdViews.push(this)
    }
  }

  const shell = { openExternal: vi.fn() }
  return { WebContentsView, shell }
})

// Reset per-test state so views map + session spies are fresh.
// The `views` map lives in preview.ts module scope, so we can't reset it directly
// — we call `preview:closeAll` via a synthetic event before each test instead.
beforeEach(() => {
  _currentSessionSpies = makeSessionSpies()
  createdViews.length = 0
})

// Checklist #17: the preview control channel is shared by all webContents. A
// foreign sender must be rejected so a previewed page can't drive another board's
// native view. preview:open throws; the navigation handlers return false.
describe('registerPreviewHandlers — foreign-sender rejection (#17)', () => {
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    return cap
  }

  it('preview:open throws for a foreign sender (no native view created)', () => {
    const cap = setup()
    expect(() => cap.invokeAs(foreignEvent, 'preview:open', { id: 'b1', bounds: {} })).toThrow(
      /forbidden sender/
    )
  })

  it('preview:navigate returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'preview:navigate', { id: 'b1', url: 'http://x/' })).toBe(
      false
    )
  })

  it('preview:goBack returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'preview:goBack', 'b1')).toBe(false)
  })

  it.each([
    ['preview:goForward', ['b1']],
    ['preview:reload', ['b1']]
  ] as const)('%s returns false for a foreign sender', (channel, args) => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, channel, ...args)).toBe(false)
  })

  it.each([
    ['preview:setBoundsBatch', [[]]],
    ['preview:detach', ['b1']],
    ['preview:detachAll', []],
    ['preview:attach', [{ id: 'b1', bounds: {} }]],
    ['preview:close', ['b1']],
    ['preview:closeAll', []]
  ] as const)('%s returns true for a foreign sender', (channel, args) => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, channel, ...args)).toBe(true)
  })

  it('preview:capture returns null for a foreign sender (async)', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'preview:capture', 'b1')).toBeNull()
  })
})

describe('preview:openExternal', () => {
  it('rejects a foreign sender (returns false)', () => {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    expect(cap.invokeAs(foreignEvent, 'preview:openExternal', 'http://localhost:3000/')).toBe(false)
  })

  it('accepts an internal (trusted) sender for an allowed scheme', () => {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    expect(cap.invokeAs(internalEvent, 'preview:openExternal', 'http://localhost:3000/')).toBe(true)
  })

  it('returns false and does NOT call shell.openExternal for a blocked scheme (file:)', () => {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    vi.mocked(shell.openExternal).mockClear()
    const result = cap.invokeAs(internalEvent, 'preview:openExternal', 'file:///etc/passwd')
    expect(result).toBe(false)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })
})

// Security: deny-by-default permission handler on per-board preview sessions
// (no-permission-handler-preview-views). Each WebContentsView gets a unique
// in-memory session (`partition: preview-<id>`). Without a permission handler,
// a previewed localhost page could prompt for camera/mic/geo/notifications/etc.
// Both the async request handler and the synchronous check handler must deny.
describe('registerPreviewHandlers — deny-by-default permission handler', () => {
  // preview:open calls ensure() (creates view) then attach() which calls
  // owner.contentView.addChildView(). The standard mainWin fixture lacks contentView,
  // so we extend it with a no-op stub for the attach path.
  const mainWinWithContentView = (): BrowserWindow =>
    ({
      isDestroyed: () => false,
      webContents: { mainFrame: { id: 'main-frame' }, isDestroyed: () => false },
      contentView: { addChildView: vi.fn() }
    }) as unknown as BrowserWindow

  it('installs setPermissionRequestHandler and setPermissionCheckHandler on the view session when a view is created', () => {
    const spies = _currentSessionSpies!
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWinWithContentView, 'http://127.0.0.1:0/')

    // preview:open with a trusted (internal) sender triggers ensure() → new WebContentsView
    cap.invokeAs(internalEvent, 'preview:open', {
      id: 'perm-test-board',
      url: 'http://localhost:5173/',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })

    // Both handlers must have been installed on the session.
    expect(spies.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(spies.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
  })

  it('the installed request handler always calls callback(false) — denying every permission', () => {
    const spies = _currentSessionSpies!
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWinWithContentView, 'http://127.0.0.1:0/')

    cap.invokeAs(internalEvent, 'preview:open', {
      id: 'perm-deny-board',
      url: 'http://localhost:5173/',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })

    // Extract the handler that was passed to setPermissionRequestHandler.
    const requestHandler = spies.setPermissionRequestHandler.mock.calls[0][0] as (
      _wc: unknown,
      _permission: string,
      callback: (granted: boolean) => void
    ) => void

    // Deny camera, mic, geolocation, notifications — all permissions.
    for (const perm of ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read']) {
      const cb = vi.fn()
      requestHandler({}, perm, cb)
      expect(cb).toHaveBeenCalledWith(false)
    }
  })

  it('the installed check handler always returns false — denying every synchronous check', () => {
    const spies = _currentSessionSpies!
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWinWithContentView, 'http://127.0.0.1:0/')

    cap.invokeAs(internalEvent, 'preview:open', {
      id: 'perm-check-board',
      url: 'http://localhost:5173/',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })

    // Extract the handler that was passed to setPermissionCheckHandler.
    const checkHandler = spies.setPermissionCheckHandler.mock.calls[0][0] as () => boolean

    expect(checkHandler()).toBe(false)
  })
})

// BUG-005: preview module state survives main-window destruction. disposeOne must
// close the webContents even when the owner window is already destroyed (detach
// would otherwise throw "Object has been destroyed" and the single try block
// skipped the mandatory close — leaking the preview renderer).
describe('preview lifecycle on a destroyed owner window (BUG-005)', () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 }

  function destructibleWin(): {
    win: BrowserWindow
    destroy: () => void
    removeChildView: ReturnType<typeof vi.fn>
  } {
    let destroyed = false
    const removeChildView = vi.fn(() => {
      if (destroyed) throw new Error('Object has been destroyed')
    })
    const win = {
      isDestroyed: () => destroyed,
      webContents: {
        mainFrame: { id: 'main-frame' },
        isDestroyed: () => destroyed,
        send: vi.fn()
      },
      contentView: { addChildView: vi.fn(), removeChildView }
    } as unknown as BrowserWindow
    return { win, destroy: () => (destroyed = true), removeChildView }
  }

  it('preview:close after the window is destroyed skips removeChildView but still closes the webContents', () => {
    const { win, destroy, removeChildView } = destructibleWin()
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, () => win, 'http://127.0.0.1:0/')
    cap.invokeAs(internalEvent, 'preview:open', {
      id: 'bug5-close-board',
      url: 'http://localhost:5173/',
      bounds
    })
    const view = createdViews[0]
    destroy()
    expect(() => cap.invokeAs(internalEvent, 'preview:close', 'bug5-close-board')).not.toThrow()
    expect(removeChildView).not.toHaveBeenCalled() // destroyed owner is never touched
    expect(view.webContents.close).toHaveBeenCalledTimes(1) // no renderer leak
  })

  it('preview:closeAll closes EVERY webContents even when detach throws mid-dispose', () => {
    const { win, removeChildView } = destructibleWin()
    // Simulate the broken-window edge: removeChildView throws while the window
    // still reports live — the split try blocks must still reach close().
    removeChildView.mockImplementation(() => {
      throw new Error('removeChildView failed')
    })
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, () => win, 'http://127.0.0.1:0/')
    cap.invokeAs(internalEvent, 'preview:open', { id: 'bug5-all-a', bounds })
    cap.invokeAs(internalEvent, 'preview:open', { id: 'bug5-all-b', bounds })
    expect(() => cap.invokeAs(internalEvent, 'preview:closeAll')).not.toThrow()
    expect(createdViews).toHaveLength(2)
    for (const v of createdViews) expect(v.webContents.close).toHaveBeenCalledTimes(1)
  })
})

// BUG-029: the wired per-view setWindowOpenHandler rate-limits gesture-free
// window.open floods (token bucket: burst 3, +1/10s) while still denying the
// in-app open. The limiter itself is unit-tested in preview.test.ts; this drives
// the handler ensure() actually installs.
describe('preview setWindowOpenHandler rate limit (BUG-029)', () => {
  it('forwards a burst of 3 opens to shell.openExternal then drops the flood, always denying in-app', () => {
    const cap = createIpcCapture()
    registerPreviewHandlers(
      cap.ipcMain,
      () =>
        ({
          isDestroyed: () => false,
          webContents: { mainFrame: { id: 'main-frame' }, isDestroyed: () => false, send: vi.fn() },
          contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
        }) as unknown as BrowserWindow,
      'http://127.0.0.1:0/'
    )
    cap.invokeAs(internalEvent, 'preview:open', {
      id: 'bug29-board',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })
    const handler = createdViews[0].webContents.setWindowOpenHandler.mock.calls[0][0] as (d: {
      url: string
    }) => { action: string }
    vi.mocked(shell.openExternal).mockClear()
    for (let i = 0; i < 10; i++) {
      expect(handler({ url: 'https://example.com/' }).action).toBe('deny')
    }
    expect(shell.openExternal).toHaveBeenCalledTimes(3)
    cap.invokeAs(internalEvent, 'preview:close', 'bug29-board')
  })
})

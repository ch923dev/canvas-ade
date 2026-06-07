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
const { makeSessionSpies } = vi.hoisted(() => {
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
  return { makeSessionSpies }
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
        id: 42
      }
      this.setVisible = vi.fn()
      this.setBounds = vi.fn()
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

  it('returns true but does NOT call shell.openExternal for a blocked scheme (file:)', () => {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    vi.mocked(shell.openExternal).mockClear()
    const result = cap.invokeAs(internalEvent, 'preview:openExternal', 'file:///etc/passwd')
    expect(result).toBe(true)
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

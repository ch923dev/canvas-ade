import { describe, it, expect, vi } from 'vitest'
import {
  isErrorResponseCode,
  isHttpErrorCode,
  isAllowedPreviewUrl,
  isAllowedExternal,
  registerPreviewNavGuards,
  registerLoadLatch,
  isForeignSender
} from './preview'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

// Bug #5: a dead/refused URL loads a Chromium error page whose did-finish-load must
// not flip the board back to "connected". The httpResponseCode from did-navigate is
// the secondary failure signal alongside the did-fail-load latch.
describe('isErrorResponseCode', () => {
  it('treats 0 (error page commit) as a failure', () => {
    expect(isErrorResponseCode(0)).toBe(true)
  })

  it('treats >= 400 (HTTP error page) as a failure', () => {
    expect(isErrorResponseCode(400)).toBe(true)
    expect(isErrorResponseCode(404)).toBe(true)
    expect(isErrorResponseCode(500)).toBe(true)
    expect(isErrorResponseCode(503)).toBe(true)
  })

  it('treats -1 (non-HTTP navigation: file:/about:) as a normal load', () => {
    expect(isErrorResponseCode(-1)).toBe(false)
  })

  it('treats 2xx / 3xx as a normal load', () => {
    expect(isErrorResponseCode(200)).toBe(false)
    expect(isErrorResponseCode(204)).toBe(false)
    expect(isErrorResponseCode(301)).toBe(false)
    expect(isErrorResponseCode(302)).toBe(false)
    expect(isErrorResponseCode(399)).toBe(false)
  })
})

// Bug #7: a 4xx/5xx server RESPONSE commits a real error page but fires NO
// did-fail-load, so its did-navigate is the ONLY failure signal — the board needs a
// terminal did-fail-load emit or it stays "connecting" forever. isHttpErrorCode
// gates that extra emit. Unlike isErrorResponseCode it must NOT fire on code 0 (the
// Chromium error page, which already had a real did-fail-load) or it would
// double-emit / regress the connection-refused path.
describe('isHttpErrorCode', () => {
  it('treats >= 400 (real HTTP error response) as a failure needing a terminal emit', () => {
    expect(isHttpErrorCode(400)).toBe(true)
    expect(isHttpErrorCode(404)).toBe(true)
    expect(isHttpErrorCode(500)).toBe(true)
    expect(isHttpErrorCode(503)).toBe(true)
  })

  it('does NOT fire on code 0 (Chromium error page already had a did-fail-load)', () => {
    expect(isHttpErrorCode(0)).toBe(false)
  })

  it('does NOT fire on a normal 2xx/3xx load or a non-HTTP (-1) navigation', () => {
    expect(isHttpErrorCode(200)).toBe(false)
    expect(isHttpErrorCode(302)).toBe(false)
    expect(isHttpErrorCode(399)).toBe(false)
    expect(isHttpErrorCode(-1)).toBe(false)
  })
})

// Bug #32: the preview's native view may only LOAD http(s) — it previews a localhost
// dev server, never the local filesystem or arbitrary protocols, so it can't be
// turned into a general browser / file viewer regardless of how board.url was set.
describe('isAllowedPreviewUrl', () => {
  it('permits http and https', () => {
    expect(isAllowedPreviewUrl('http://127.0.0.1:3000/')).toBe(true)
    expect(isAllowedPreviewUrl('http://localhost:5173/app')).toBe(true)
    expect(isAllowedPreviewUrl('https://example.com')).toBe(true)
  })

  it('rejects file:, data:, smb: and custom schemes', () => {
    expect(isAllowedPreviewUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isAllowedPreviewUrl('data:text/html,<h1>x</h1>')).toBe(false)
    expect(isAllowedPreviewUrl('smb://host/share')).toBe(false)
    expect(isAllowedPreviewUrl('myapp://payload')).toBe(false)
    expect(isAllowedPreviewUrl('mailto:a@b.com')).toBe(false) // not a page to preview
  })

  it('rejects a non-URL string', () => {
    expect(isAllowedPreviewUrl('not a url')).toBe(false)
    expect(isAllowedPreviewUrl('')).toBe(false)
  })
})

// Bug #23: shell.openExternal only receives an allowlisted scheme — untrusted preview
// content can window.open('file:///…')/'smb://…'/a custom protocol, which must NOT
// reach the OS handler. Web + mail only.
describe('isAllowedExternal', () => {
  it('permits http, https and mailto', () => {
    expect(isAllowedExternal('https://example.com')).toBe(true)
    expect(isAllowedExternal('http://example.com')).toBe(true)
    expect(isAllowedExternal('mailto:a@b.com')).toBe(true)
  })

  it('rejects file:, smb: and custom schemes', () => {
    expect(isAllowedExternal('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isAllowedExternal('smb://attacker-host/share')).toBe(false)
    expect(isAllowedExternal('ms-calculator:')).toBe(false)
  })

  it('rejects javascript: and a non-URL string', () => {
    expect(isAllowedExternal('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternal('')).toBe(false)
  })
})

// Bug #14: the preview's http(s)-only scheme guard was registered on will-navigate
// only, so the 30x redirect leg (will-redirect) and subframe navigations
// (will-frame-navigate) bypassed it — a previewed localhost origin could 302 the view
// to file:/data:/custom and turn the sandboxed preview into a file viewer. The shared
// guard is now wired onto all three events. This drives a fake webContents emitter to
// assert preventDefault fires for a disallowed scheme on every guarded event and is
// NOT called for an allowed http(s) target.
describe('registerPreviewNavGuards', () => {
  type Listener = (...args: unknown[]) => void

  function fakeWc(): {
    on: (event: string, listener: Listener) => unknown
    emit: (event: string, ...args: unknown[]) => void
  } {
    const handlers = new Map<string, Listener>()
    return {
      on: (event, listener) => {
        handlers.set(event, listener)
        return undefined
      },
      emit: (event, ...args) => handlers.get(event)?.(...args)
    }
  }

  it('preventDefaults a disallowed-scheme will-navigate (top frame)', () => {
    const wc = fakeWc()
    registerPreviewNavGuards(wc as never)
    const ev = { preventDefault: vi.fn() }
    wc.emit('will-navigate', ev, 'file:///C:/Windows/win.ini')
    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('preventDefaults a disallowed-scheme will-redirect (30x leg)', () => {
    const wc = fakeWc()
    registerPreviewNavGuards(wc as never)
    const ev = { preventDefault: vi.fn() }
    wc.emit('will-redirect', ev, 'file:///C:/Users/secret')
    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('preventDefaults a disallowed-scheme will-frame-navigate (subframe via details.url)', () => {
    const wc = fakeWc()
    registerPreviewNavGuards(wc as never)
    const details = { url: 'data:text/html,<h1>x</h1>', preventDefault: vi.fn() }
    wc.emit('will-frame-navigate', details)
    expect(details.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('does NOT preventDefault an allowed http(s) target on any guarded event', () => {
    const wc = fakeWc()
    registerPreviewNavGuards(wc as never)
    const nav = { preventDefault: vi.fn() }
    wc.emit('will-navigate', nav, 'http://localhost:5173/app')
    const redir = { preventDefault: vi.fn() }
    wc.emit('will-redirect', redir, 'https://localhost:5173/next')
    const frame = { url: 'http://127.0.0.1:3000/', preventDefault: vi.fn() }
    wc.emit('will-frame-navigate', frame)
    expect(nav.preventDefault).not.toHaveBeenCalled()
    expect(redir.preventDefault).not.toHaveBeenCalled()
    expect(frame.preventDefault).not.toHaveBeenCalled()
  })
})

// TEST T5 (Bug #5): the `failed` latch suppresses the spurious did-finish-load that
// Chromium fires for its error page AFTER a real did-fail-load, and a fresh
// did-start-navigation resets it so a later successful load can promote to
// "connected". Drive the extracted registerLoadLatch with a fake emitter.
describe('registerLoadLatch (failed-latch lifecycle)', () => {
  type Listener = (...args: unknown[]) => void

  function fakeWc(): {
    on: (event: string, listener: Listener) => unknown
    emit: (event: string, ...args: unknown[]) => void
  } {
    const handlers = new Map<string, Listener>()
    return {
      on: (event, listener) => {
        handlers.set(event, listener)
        return undefined
      },
      emit: (event, ...args) => handlers.get(event)?.(...args)
    }
  }

  function setup(): {
    wc: ReturnType<typeof fakeWc>
    latch: { failed: boolean }
    hooks: {
      applyZoom: ReturnType<typeof vi.fn>
      onNavStart: ReturnType<typeof vi.fn>
      onSuccess: ReturnType<typeof vi.fn>
      onFail: ReturnType<typeof vi.fn>
    }
  } {
    const wc = fakeWc()
    const latch = { failed: false }
    const hooks = {
      getUrl: () => 'http://localhost:5173/',
      applyZoom: vi.fn(),
      onNavStart: vi.fn(),
      onSuccess: vi.fn(),
      onFail: vi.fn()
    }
    registerLoadLatch(wc as never, latch, hooks)
    return { wc, latch, hooks }
  }

  it('suppresses the error page did-finish-load while failed is latched', () => {
    const { wc, latch, hooks } = setup()
    // Connection refused: a real main-frame did-fail-load latches failed.
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    expect(latch.failed).toBe(true)
    expect(hooks.onFail).toHaveBeenCalledTimes(1)
    // Chromium then loads its error page → did-finish-load. Success must NOT emit.
    wc.emit('did-finish-load')
    expect(hooks.onSuccess).not.toHaveBeenCalled()
    // Zoom is still re-applied for the error page (it lays out).
    expect(hooks.applyZoom).toHaveBeenCalledTimes(1)
  })

  it('did-start-navigation resets the latch so a later did-finish-load promotes', () => {
    const { wc, latch, hooks } = setup()
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    expect(latch.failed).toBe(true)
    // A fresh main-frame navigation (reload/back/forward) clears the latch.
    wc.emit('did-start-navigation', { isMainFrame: true })
    expect(latch.failed).toBe(false)
    expect(hooks.onNavStart).toHaveBeenCalledTimes(1)
    // The successful load now promotes to "connected".
    wc.emit('did-finish-load')
    expect(hooks.onSuccess).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('ignores subframe did-start-navigation and aborted/-3 + subframe did-fail-load', () => {
    const { wc, latch, hooks } = setup()
    // Latch first so we can observe non-resets.
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    // Subframe nav start must not clear the main-frame latch.
    wc.emit('did-start-navigation', { isMainFrame: false })
    expect(latch.failed).toBe(true)
    expect(hooks.onNavStart).not.toHaveBeenCalled()
    // Reset, then assert non-board-level failures don't latch.
    latch.failed = false
    hooks.onFail.mockClear()
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:5173/', true) // aborted
    wc.emit('did-fail-load', {}, -102, 'ERR_FAILED', 'http://localhost:5173/sub', false) // subframe
    expect(latch.failed).toBe(false)
    expect(hooks.onFail).not.toHaveBeenCalled()
  })
})

// Bug M6: the frame guard must DENY when the window is unresolved but the sender is a
// real frame (a destroyed/reloading window must not let a foreign frame slip through),
// allow a synthetic/internal call (no senderFrame), allow the genuine main frame, and
// block any other frame.
describe('isForeignSender', () => {
  const mainFrame = { name: 'main' } as unknown as IpcMainInvokeEvent['senderFrame']
  const foreignFrame = { name: 'foreign' } as unknown as IpcMainInvokeEvent['senderFrame']
  const winWithMain = (): BrowserWindow =>
    ({ webContents: { mainFrame } }) as unknown as BrowserWindow

  it('allows a synthetic/internal call with no senderFrame', () => {
    expect(isForeignSender({ senderFrame: null }, () => winWithMain())).toBe(false)
  })

  it('blocks a real foreign frame', () => {
    expect(isForeignSender({ senderFrame: foreignFrame }, () => winWithMain())).toBe(true)
  })

  it('allows the genuine main frame', () => {
    expect(isForeignSender({ senderFrame: mainFrame }, () => winWithMain())).toBe(false)
  })

  it('blocks a real sender when the window is unresolved (null)', () => {
    expect(isForeignSender({ senderFrame: mainFrame }, () => null)).toBe(true)
  })
})

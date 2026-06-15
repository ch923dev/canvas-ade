import { describe, it, expect, vi } from 'vitest'
import { applyOsrInitialLoad } from './previewOsr'

// BUG-005: in OSR mode, ensureOsr used `if (isAllowedPreviewUrl(url)) wc.loadURL(url)` with NO
// else, so a blocked (non-http(s)) scheme skipped the load AND emitted no lifecycle event ->
// useOffscreenPreview stayed on 'connecting' forever and leaked an idle offscreen renderer. The
// native path (preview.ts preview:open / preview:navigate) emits a synthetic did-fail-load
// (errorCode -1, 'blocked scheme') on the rejected branch; applyOsrInitialLoad — the exact gate
// ensureOsr now calls — must mirror it. These drive the REAL gate (no faked status).
describe('applyOsrInitialLoad (BUG-005 blocked-scheme terminal failure)', () => {
  it('loads an allowed http(s) url and emits NO failure', () => {
    const e = { failed: false }
    const load = vi.fn()
    const emit = vi.fn()
    applyOsrInitialLoad('b1', 'http://localhost:5173/app', e, load, emit)
    expect(load).toHaveBeenCalledWith('http://localhost:5173/app')
    expect(emit).not.toHaveBeenCalled()
    expect(e.failed).toBe(false)
  })

  it('latches failed + emits a synthetic did-fail-load for a blocked scheme (no load)', () => {
    const e = { failed: false }
    const load = vi.fn()
    const emit = vi.fn()
    applyOsrInitialLoad('b2', 'file:///C:/Windows/win.ini', e, load, emit)
    // The bug: without the else-branch, neither of these would happen and the renderer hangs.
    expect(load).not.toHaveBeenCalled()
    expect(e.failed).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      id: 'b2',
      type: 'did-fail-load',
      url: 'file:///C:/Windows/win.ini',
      errorCode: -1,
      errorDescription: 'blocked scheme'
    })
  })

  it('treats data: and a non-URL string as blocked-scheme failures too', () => {
    for (const bad of ['data:text/html,<h1>x</h1>', 'not a url', '']) {
      const e = { failed: false }
      const load = vi.fn()
      const emit = vi.fn()
      applyOsrInitialLoad('b3', bad, e, load, emit)
      expect(load).not.toHaveBeenCalled()
      expect(e.failed).toBe(true)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit.mock.calls[0][0]).toMatchObject({
        type: 'did-fail-load',
        url: bad,
        errorCode: -1,
        errorDescription: 'blocked scheme'
      })
    }
  })
})

import { describe, it, expect } from 'vitest'
import {
  isErrorResponseCode,
  isHttpErrorCode,
  isAllowedPreviewUrl,
  isAllowedExternal
} from './preview'

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

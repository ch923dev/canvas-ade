import { describe, it, expect } from 'vitest'
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
  normalizeDocPath,
  navDecision
} from './windowSecurity'

// Checklist #3/#4: the main window must run with contextIsolation + sandbox ON and
// nodeIntegration + webviewTag OFF. These are the load-bearing isolation flags.
describe('buildMainWindowWebPreferences (#3/#4)', () => {
  const wp = buildMainWindowWebPreferences('/app/out/preload/index.js')

  it('enables context isolation and sandbox', () => {
    expect(wp.contextIsolation).toBe(true)
    expect(wp.sandbox).toBe(true)
  })

  it('disables nodeIntegration and webviewTag', () => {
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.webviewTag).toBe(false)
  })

  it('passes the preload path through', () => {
    expect(wp.preload).toBe('/app/out/preload/index.js')
  })
})

// Checklist #13/#14: the main window ALWAYS denies in-app window creation; an
// allowlisted-scheme URL is handed to the OS browser, everything else is dropped.
describe('windowOpenDecision (#13/#14)', () => {
  it('always denies the in-app window', () => {
    expect(windowOpenDecision('https://example.com').action).toBe('deny')
    expect(windowOpenDecision('file:///C:/x').action).toBe('deny')
  })

  it('routes http/https/mailto to the OS browser', () => {
    expect(windowOpenDecision('https://example.com').openExternal).toBe('https://example.com')
    expect(windowOpenDecision('http://localhost:5173/').openExternal).toBe('http://localhost:5173/')
    expect(windowOpenDecision('mailto:a@b.com').openExternal).toBe('mailto:a@b.com')
  })

  it('drops file:/custom/javascript:/non-url (no external open)', () => {
    expect(windowOpenDecision('file:///C:/Windows/calc.exe').openExternal).toBeNull()
    expect(windowOpenDecision('myapp://payload').openExternal).toBeNull()
    expect(windowOpenDecision('javascript:alert(1)').openExternal).toBeNull()
    expect(windowOpenDecision('not a url').openExternal).toBeNull()
  })
})

// The app origin the window is pinned to: dev = renderer dev-server origin;
// packaged (no renderer URL) = null (a file: URL's origin is the string "null").
describe('computeAppOrigin', () => {
  it('returns the dev renderer origin', () => {
    expect(computeAppOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
  })

  it('returns null for undefined (packaged) and for a bad URL', () => {
    expect(computeAppOrigin(undefined)).toBeNull()
    expect(computeAppOrigin('::::not a url')).toBeNull()
  })
})

// normalizeDocPath: the packaged app-document pathname is normalized so a file:
// URL's pathname can be compared against it ignoring percent-encoding (%20) and,
// on Windows, ASCII case (file paths are case-insensitive there).
describe('normalizeDocPath', () => {
  it('decodes percent-encoding and lowercases (win32-style)', () => {
    expect(normalizeDocPath('/C:/Program%20Files/App/index.html', 'win32')).toBe(
      '/c:/program files/app/index.html'
    )
  })

  it('preserves case on non-win32 (file paths are case-sensitive)', () => {
    expect(normalizeDocPath('/opt/App/index.html', 'linux')).toBe('/opt/App/index.html')
  })

  it('returns null/undefined unchanged', () => {
    expect(normalizeDocPath(null, 'win32')).toBeNull()
    expect(normalizeDocPath(undefined, 'win32')).toBeUndefined()
  })
})

// Checklist #13: the main window must never navigate away from its own document.
// Same-ORIGIN navigation is allowed (so ?e2e=1 / hash changes pass); a different
// origin is blocked and, if http(s)/mailto, routed to the OS browser. For a
// PACKAGED build (appOrigin null), a file: URL is allowed ONLY when it targets the
// app's own document (appDocPath) — every other local file is blocked.
describe('navDecision (#13)', () => {
  // The packaged app document, as computed in index.ts from loadFile's path.
  const APP_DOC = '/C:/app/resources/app.asar/out/renderer/index.html'

  it('allows same-origin navigation (query/hash change)', () => {
    expect(
      navDecision('http://localhost:5173/?e2e=1', { appOrigin: 'http://localhost:5173' })
    ).toEqual({
      allow: true,
      openExternal: null
    })
  })

  it('allows the app document file: URL in packaged build (appOrigin null)', () => {
    expect(
      navDecision('file:///C:/app/resources/app.asar/out/renderer/index.html', {
        appOrigin: null,
        appDocPath: APP_DOC,
        platform: 'win32'
      })
    ).toEqual({ allow: true, openExternal: null })
  })

  it('allows the app document file: URL with ?e2e=1 query and a #hash', () => {
    expect(
      navDecision('file:///C:/app/resources/app.asar/out/renderer/index.html?e2e=1#/board/3', {
        appOrigin: null,
        appDocPath: APP_DOC,
        platform: 'win32'
      })
    ).toEqual({ allow: true, openExternal: null })
  })

  it('allows the app document file: URL ignoring ASCII case on win32', () => {
    expect(
      navDecision('file:///C:/APP/resources/app.asar/out/renderer/INDEX.HTML', {
        appOrigin: null,
        appDocPath: APP_DOC,
        platform: 'win32'
      })
    ).toEqual({ allow: true, openExternal: null })
  })

  it('allows the app document file: URL with percent-encoded spaces in the path', () => {
    expect(
      navDecision('file:///C:/Program%20Files/App/out/renderer/index.html', {
        appOrigin: null,
        appDocPath: '/C:/Program Files/App/out/renderer/index.html',
        platform: 'win32'
      })
    ).toEqual({ allow: true, openExternal: null })
  })

  it('BLOCKS file:///etc/passwd in packaged build (not the app doc)', () => {
    expect(
      navDecision('file:///etc/passwd', {
        appOrigin: null,
        appDocPath: APP_DOC,
        platform: 'win32'
      })
    ).toEqual({ allow: false, openExternal: null })
  })

  it('BLOCKS file:///C:/Windows/win.ini in packaged build (not the app doc)', () => {
    expect(
      navDecision('file:///C:/Windows/win.ini', {
        appOrigin: null,
        appDocPath: APP_DOC,
        platform: 'win32'
      })
    ).toEqual({ allow: false, openExternal: null })
  })

  it('BLOCKS a sibling file in the app document directory', () => {
    expect(
      navDecision('file:///C:/app/resources/app.asar/out/renderer/secret.html', {
        appOrigin: null,
        appDocPath: APP_DOC,
        platform: 'win32'
      })
    ).toEqual({ allow: false, openExternal: null })
  })

  it('BLOCKS any file: URL when appDocPath is unset (defensive — no pin available)', () => {
    expect(navDecision('file:///C:/app/index.html', { appOrigin: null })).toEqual({
      allow: false,
      openExternal: null
    })
  })

  it('blocks a different http origin and routes it externally', () => {
    expect(navDecision('https://evil.com/', { appOrigin: 'http://localhost:5173' })).toEqual({
      allow: false,
      openExternal: 'https://evil.com/'
    })
  })

  it('blocks a cross-origin http nav in the packaged build (appOrigin null) and routes it externally', () => {
    expect(navDecision('https://evil.com/', { appOrigin: null })).toEqual({
      allow: false,
      openExternal: 'https://evil.com/'
    })
  })

  it('blocks a file: drop in dev (appOrigin set, no appDocPath) with no external open', () => {
    expect(
      navDecision('file:///C:/Windows/win.ini', { appOrigin: 'http://localhost:5173' })
    ).toEqual({
      allow: false,
      openExternal: null
    })
  })

  it('blocks an unparseable URL with no external open', () => {
    expect(navDecision('::::bad', { appOrigin: 'http://localhost:5173' })).toEqual({
      allow: false,
      openExternal: null
    })
  })
})

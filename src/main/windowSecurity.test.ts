import { describe, it, expect } from 'vitest'
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
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

// Checklist #13: the main window must never navigate away from its own document.
// Same-ORIGIN navigation is allowed (so ?e2e=1 / hash changes pass); a different
// origin is blocked and, if http(s)/mailto, routed to the OS browser.
describe('navDecision (#13)', () => {
  it('allows same-origin navigation (query/hash change)', () => {
    expect(navDecision('http://localhost:5173/?e2e=1', 'http://localhost:5173')).toEqual({
      allow: true,
      openExternal: null
    })
  })

  it('allows a file: URL when appOrigin is null (packaged build)', () => {
    expect(navDecision('file:///C:/app/index.html', null)).toEqual({
      allow: true,
      openExternal: null
    })
  })

  it('blocks a different http origin and routes it externally', () => {
    expect(navDecision('https://evil.com/', 'http://localhost:5173')).toEqual({
      allow: false,
      openExternal: 'https://evil.com/'
    })
  })

  it('blocks a cross-origin http nav in the packaged build (appOrigin null) and routes it externally', () => {
    expect(navDecision('https://evil.com/', null)).toEqual({
      allow: false,
      openExternal: 'https://evil.com/'
    })
  })

  it('blocks a file: drop in dev (different origin) with no external open', () => {
    expect(navDecision('file:///C:/Windows/win.ini', 'http://localhost:5173')).toEqual({
      allow: false,
      openExternal: null
    })
  })

  it('blocks an unparseable URL with no external open', () => {
    expect(navDecision('::::bad', 'http://localhost:5173')).toEqual({
      allow: false,
      openExternal: null
    })
  })
})

import { describe, it, expect } from 'vitest'
import { parseAuthDeepLink, deepLinkFromArgv } from './authDeepLink'

describe('parseAuthDeepLink', () => {
  it('accepts an expanse:// callback and extracts host + path (drops the query)', () => {
    expect(parseAuthDeepLink('expanse://auth/callback?code=abc&state=xyz')).toEqual({
      host: 'auth',
      path: '/callback'
    })
  })

  it('rejects a non-expanse scheme (no embedded-browser / arbitrary-scheme handling)', () => {
    expect(parseAuthDeepLink('https://auth/callback?code=abc')).toBeNull()
    expect(parseAuthDeepLink('file:///etc/passwd')).toBeNull()
  })

  it('rejects a malformed URL rather than throwing', () => {
    expect(parseAuthDeepLink('not a url')).toBeNull()
    expect(parseAuthDeepLink('')).toBeNull()
  })

  it('rejects an expanse:// URL whose host/path is not the auth callback route (fail closed)', () => {
    expect(parseAuthDeepLink('expanse://other/path')).toBeNull()
    expect(parseAuthDeepLink('expanse://auth/not-callback')).toBeNull()
    expect(parseAuthDeepLink('expanse://auth/callback/extra')).toBeNull()
    expect(parseAuthDeepLink('expanse://evil/callback?code=abc&state=xyz')).toBeNull()
  })
})

describe('deepLinkFromArgv', () => {
  it('finds the expanse:// entry among launch args', () => {
    expect(
      deepLinkFromArgv(['C:/app/Expanse.exe', '--flag', 'expanse://auth/callback?code=1'])
    ).toBe('expanse://auth/callback?code=1')
  })

  it('returns undefined when no deep-link is present', () => {
    expect(deepLinkFromArgv(['C:/app/Expanse.exe', '--flag'])).toBeUndefined()
  })
})

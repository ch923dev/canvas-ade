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

import { describe, it, expect } from 'vitest'
import {
  isOpenableScheme,
  isLocalHost,
  classifyLinkHost,
  resolveLinkDestination
} from './terminalLinks'

describe('isOpenableScheme', () => {
  it('allows http / https / mailto', () => {
    expect(isOpenableScheme('http://localhost:3000/')).toBe(true)
    expect(isOpenableScheme('https://example.com/path?q=1#h')).toBe(true)
    expect(isOpenableScheme('mailto:dev@example.com')).toBe(true)
  })
  it('rejects file / javascript / data / custom schemes', () => {
    expect(isOpenableScheme('file:///C:/Windows/calc.exe')).toBe(false)
    expect(isOpenableScheme('javascript:alert(1)')).toBe(false)
    expect(isOpenableScheme('data:text/html,<h1>x</h1>')).toBe(false)
    expect(isOpenableScheme('vscode://file/x')).toBe(false)
    expect(isOpenableScheme('smb://share/x')).toBe(false)
  })
  it('rejects garbage that does not parse as a URL', () => {
    expect(isOpenableScheme('not a url')).toBe(false)
    expect(isOpenableScheme('')).toBe(false)
    expect(isOpenableScheme('localhost:3000')).toBe(false) // no scheme → unparseable
  })
})

describe('isLocalHost', () => {
  it('treats loopback / unspecified names as local', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('LOCALHOST')).toBe(true)
    expect(isLocalHost('app.localhost')).toBe(true)
    expect(isLocalHost('127.0.0.1')).toBe(true)
    expect(isLocalHost('127.5.6.7')).toBe(true) // whole 127/8 is loopback
    expect(isLocalHost('0.0.0.0')).toBe(true)
    expect(isLocalHost('::1')).toBe(true)
    expect(isLocalHost('[::1]')).toBe(true) // URL.hostname keeps IPv6 brackets
    expect(isLocalHost('0:0:0:0:0:0:0:1')).toBe(true)
  })
  it('treats mDNS *.local as local', () => {
    expect(isLocalHost('mybox.local')).toBe(true)
    expect(isLocalHost('local')).toBe(true)
  })
  it('treats the three RFC 1918 private ranges as local', () => {
    expect(isLocalHost('10.0.0.5')).toBe(true)
    expect(isLocalHost('10.255.255.255')).toBe(true)
    expect(isLocalHost('192.168.1.10')).toBe(true)
    expect(isLocalHost('172.16.0.1')).toBe(true)
    expect(isLocalHost('172.31.255.255')).toBe(true)
    expect(isLocalHost('172.20.5.5')).toBe(true)
  })
  it('treats public IPs / domains / near-miss private ranges as remote', () => {
    expect(isLocalHost('8.8.8.8')).toBe(false)
    expect(isLocalHost('example.com')).toBe(false)
    expect(isLocalHost('11.0.0.1')).toBe(false)
    expect(isLocalHost('192.169.0.1')).toBe(false)
    expect(isLocalHost('172.15.0.1')).toBe(false) // just below the /12
    expect(isLocalHost('172.32.0.1')).toBe(false) // just above the /12
    expect(isLocalHost('127.0.0.1.evil.com')).toBe(false) // not a dotted quad
    expect(isLocalHost('999.1.1.1')).toBe(false) // invalid octet
    expect(isLocalHost('')).toBe(false)
  })
})

describe('classifyLinkHost', () => {
  it('maps host to local / remote', () => {
    expect(classifyLinkHost('http://localhost:5173/')).toBe('local')
    expect(classifyLinkHost('http://192.168.0.10:8080/x')).toBe('local')
    expect(classifyLinkHost('https://github.com/owner/repo')).toBe('remote')
  })
  it('defaults an unparseable URL to remote (the safe side)', () => {
    expect(classifyLinkHost('not a url')).toBe('remote')
  })
})

describe('resolveLinkDestination', () => {
  it('local → board, remote → external (no modifier)', () => {
    expect(resolveLinkDestination('http://localhost:3000/', { shiftKey: false })).toBe('board')
    expect(resolveLinkDestination('https://example.com/', { shiftKey: false })).toBe('external')
  })
  it('Shift flips both directions', () => {
    expect(resolveLinkDestination('http://localhost:3000/', { shiftKey: true })).toBe('external')
    expect(resolveLinkDestination('https://example.com/', { shiftKey: true })).toBe('board')
  })
  it('mailto is always external, Shift is a no-op', () => {
    expect(resolveLinkDestination('mailto:a@b.com', { shiftKey: false })).toBe('external')
    expect(resolveLinkDestination('mailto:a@b.com', { shiftKey: true })).toBe('external')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseLocalFeedConfig,
  readLocalFeedOverride,
  LOCAL_FEED_CONFIG_FILE
} from './localUpdateFeed'

// The validation matrix is the security surface: only a loopback-LITERAL http(s) URL may
// ever come back non-null (see the module header — this is the fence that keeps the ADR 0008
// invariant intact for the dev-only channel).
describe('parseLocalFeedConfig — loopback-literal validation', () => {
  const cfg = (url: unknown): string => JSON.stringify({ url })

  it('accepts http://127.0.0.1 with a port, stripping trailing slashes', () => {
    expect(parseLocalFeedConfig(cfg('http://127.0.0.1:8090/'))).toBe('http://127.0.0.1:8090')
    expect(parseLocalFeedConfig(cfg('http://127.0.0.1:8090'))).toBe('http://127.0.0.1:8090')
  })

  it('accepts https and a subpath', () => {
    expect(parseLocalFeedConfig(cfg('https://127.0.0.1:8443/feed/'))).toBe(
      'https://127.0.0.1:8443/feed'
    )
  })

  it('accepts the IPv6 loopback literal [::1]', () => {
    expect(parseLocalFeedConfig(cfg('http://[::1]:8090/'))).toBe('http://[::1]:8090')
  })

  it('REJECTS localhost — DNS name, not a literal (hosts-file remappable)', () => {
    expect(parseLocalFeedConfig(cfg('http://localhost:8090/'))).toBeNull()
    expect(parseLocalFeedConfig(cfg('http://LOCALHOST:8090/'))).toBeNull()
  })

  it('REJECTS non-loopback and lookalike hosts', () => {
    expect(parseLocalFeedConfig(cfg('http://192.168.1.5:8090/'))).toBeNull()
    expect(parseLocalFeedConfig(cfg('http://127.0.0.2:8090/'))).toBeNull() // strict literal, not /8
    expect(parseLocalFeedConfig(cfg('http://127.0.0.1.evil.example/'))).toBeNull()
    expect(parseLocalFeedConfig(cfg('https://updates.expanse.app/'))).toBeNull()
  })

  it('REJECTS non-http(s) schemes', () => {
    expect(parseLocalFeedConfig(cfg('file:///C:/feed'))).toBeNull()
    expect(parseLocalFeedConfig(cfg('ftp://127.0.0.1/'))).toBeNull()
  })

  it('REJECTS malformed payloads (bad JSON / wrong shapes) — fail-closed', () => {
    expect(parseLocalFeedConfig('not json')).toBeNull()
    expect(parseLocalFeedConfig('null')).toBeNull()
    expect(parseLocalFeedConfig('"http://127.0.0.1:8090/"')).toBeNull() // bare string, not {url}
    expect(parseLocalFeedConfig('{}')).toBeNull()
    expect(parseLocalFeedConfig(cfg(8090))).toBeNull()
    expect(parseLocalFeedConfig(cfg('not a url'))).toBeNull()
  })
})

describe('readLocalFeedOverride — userData config file', () => {
  const withDir = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'lufeed-'))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('absent file → null, silently (the normal no-channel case)', () => {
    withDir((dir) => {
      const logError = vi.fn()
      expect(readLocalFeedOverride(dir, logError)).toBeNull()
      expect(logError).not.toHaveBeenCalled()
    })
  })

  it('valid file → the feed URL', () => {
    withDir((dir) => {
      writeFileSync(join(dir, LOCAL_FEED_CONFIG_FILE), '{"url":"http://127.0.0.1:8090/"}')
      expect(readLocalFeedOverride(dir, vi.fn())).toBe('http://127.0.0.1:8090')
    })
  })

  it('present-but-invalid file → null AND logged (maintainer mistake, surfaced)', () => {
    withDir((dir) => {
      writeFileSync(join(dir, LOCAL_FEED_CONFIG_FILE), '{"url":"http://localhost:8090/"}')
      const logError = vi.fn()
      expect(readLocalFeedOverride(dir, logError)).toBeNull()
      expect(logError).toHaveBeenCalledOnce()
    })
  })
})

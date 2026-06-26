import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAuthTokenStore, type TokenBundle } from './authTokenStore'
import type { Encryptor } from './llmKeyStore'

// Reversible non-crypto fake (mirrors llmKeyStore.test): tags the plaintext so a test can prove the
// on-disk bytes are NOT the raw tokens, while staying decryptable. `available` toggles the
// Linux-no-keyring path.
function fakeEncryptor(available = true): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
    decryptString: (enc) => enc.toString('utf8').replace(/^ENC:/, '')
  }
}

const bundle: TokenBundle = { accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: 1000 }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authtokens-test-'))
})

describe('createAuthTokenStore', () => {
  it('round-trips the token bundle through encrypt → persist → decrypt', () => {
    const store = createAuthTokenStore(dir, fakeEncryptor())
    expect(store.setTokens(bundle)).toBe(true)
    expect(store.hasTokens()).toBe(true)
    expect(store.getTokens()).toEqual(bundle)
  })

  it('never writes raw token material to disk (the file holds ciphertext)', () => {
    const store = createAuthTokenStore(dir, fakeEncryptor())
    store.setTokens(bundle)
    const raw = readFileSync(join(dir, 'auth-tokens.json'), 'utf8')
    expect(raw).not.toContain('at-secret')
    expect(raw).not.toContain('rt-secret')
  })

  it('clearTokens removes the stored bundle', () => {
    const store = createAuthTokenStore(dir, fakeEncryptor())
    store.setTokens(bundle)
    store.clearTokens()
    expect(store.hasTokens()).toBe(false)
    expect(store.getTokens()).toBeUndefined()
  })

  it('refuses to persist when encryption is unavailable (no plaintext fallback)', () => {
    const store = createAuthTokenStore(dir, fakeEncryptor(false))
    expect(store.setTokens(bundle)).toBe(false)
    expect(existsSync(join(dir, 'auth-tokens.json'))).toBe(false)
    expect(store.hasTokens()).toBe(false)
  })

  it('returns undefined for a corrupt store file rather than throwing', () => {
    const store = createAuthTokenStore(dir, fakeEncryptor())
    store.setTokens(bundle)
    writeFileSync(join(dir, 'auth-tokens.json'), '{ not json', 'utf8')
    expect(store.getTokens()).toBeUndefined()
    expect(store.hasTokens()).toBe(false)
  })

  // Encryption available at WRITE but unavailable at READ (keyring stopped after the bundle was
  // stored). getTokens can't decrypt → undefined; hasTokens must AGREE (false), not a misleading true.
  it('hasTokens agrees with getTokens when encryption becomes unavailable after a write', () => {
    let available = true
    const flippable: Encryptor = {
      isEncryptionAvailable: () => available,
      encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
      decryptString: (enc) => enc.toString('utf8').replace(/^ENC:/, '')
    }
    const store = createAuthTokenStore(dir, flippable)
    expect(store.setTokens(bundle)).toBe(true)
    expect(store.hasTokens()).toBe(true)
    available = false // keyring stopped
    expect(store.getTokens()).toBeUndefined()
    expect(store.hasTokens()).toBe(false)
  })

  // A present, non-empty entry whose ciphertext fails to decrypt (corruption / keyring user change).
  it('hasTokens agrees with getTokens when stored ciphertext fails to decrypt', () => {
    const throwingDecrypt: Encryptor = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
      decryptString: () => {
        throw new Error('decrypt failed (corrupt ciphertext)')
      }
    }
    writeFileSync(
      join(dir, 'auth-tokens.json'),
      JSON.stringify({ bundle: Buffer.from('garbage', 'utf8').toString('base64') }),
      'utf8'
    )
    const store = createAuthTokenStore(dir, throwingDecrypt)
    expect(store.getTokens()).toBeUndefined()
    expect(store.hasTokens()).toBe(false)
  })
})

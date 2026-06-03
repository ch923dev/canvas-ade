import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createKeyStore, type Encryptor } from './llmKeyStore'

// Reversible non-crypto fake: tags the plaintext so a test can prove the on-disk bytes
// are NOT the raw key, while staying decryptable. `available` toggles the Linux-no-keyring path.
function fakeEncryptor(available = true): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
    decryptString: (enc) => enc.toString('utf8').replace(/^ENC:/, '')
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
})

describe('createKeyStore', () => {
  it('round-trips a key through encrypt → persist → decrypt', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    expect(store.setKey('openrouter', 'sk-secret')).toBe(true)
    expect(store.hasKey('openrouter')).toBe(true)
    expect(store.getKey('openrouter')).toBe('sk-secret')
  })

  it('never writes the raw key to disk (the file holds ciphertext, not plaintext)', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openai', 'PLAINTEXT-KEY')
    const raw = readFileSync(join(dir, 'llm-keys.json'), 'utf8')
    expect(raw).not.toContain('PLAINTEXT-KEY')
  })

  it('keeps keys separate per provider', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openrouter', 'a')
    store.setKey('anthropic', 'b')
    expect(store.getKey('openrouter')).toBe('a')
    expect(store.getKey('anthropic')).toBe('b')
    expect(store.hasKey('openai')).toBe(false)
    expect(store.getKey('openai')).toBeUndefined()
  })

  it('clearKey removes only that provider', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openrouter', 'a')
    store.setKey('anthropic', 'b')
    store.clearKey('openrouter')
    expect(store.hasKey('openrouter')).toBe(false)
    expect(store.getKey('anthropic')).toBe('b')
  })

  it('refuses to persist when encryption is unavailable (no plaintext fallback)', () => {
    const store = createKeyStore(dir, fakeEncryptor(false))
    expect(store.setKey('openrouter', 'x')).toBe(false)
    expect(existsSync(join(dir, 'llm-keys.json'))).toBe(false)
    expect(store.hasKey('openrouter')).toBe(false)
  })

  it('returns undefined for a corrupt store file rather than throwing', () => {
    const store = createKeyStore(dir, fakeEncryptor())
    store.setKey('openrouter', 'a')
    writeFileSync(join(dir, 'llm-keys.json'), '{ not json', 'utf8')
    expect(store.getKey('openrouter')).toBeUndefined()
    expect(store.hasKey('openrouter')).toBe(false)
  })
})

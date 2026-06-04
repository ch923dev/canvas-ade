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

  // BUG-005 (1): encryption available at WRITE but unavailable at READ (keyring stopped after the
  // key was stored). getKey can't decrypt → undefined; hasKey must AGREE (false), not report a
  // misleading true. Old behaviour: hasKey returned true off the raw on-disk string → split-brain.
  it('hasKey agrees with getKey when encryption becomes unavailable after a key was written', () => {
    let available = true
    const flippable: Encryptor = {
      isEncryptionAvailable: () => available,
      encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
      decryptString: (enc) => enc.toString('utf8').replace(/^ENC:/, '')
    }
    const store = createKeyStore(dir, flippable)
    expect(store.setKey('openrouter', 'sk-secret')).toBe(true)
    expect(store.hasKey('openrouter')).toBe(true) // available → present + decryptable
    available = false // keyring stopped
    expect(store.getKey('openrouter')).toBeUndefined() // inaccessible, not exposed as plaintext
    expect(store.hasKey('openrouter')).toBe(false) // no split-brain: hasKey now agrees
  })

  // BUG-005 (2): a present, non-empty entry whose ciphertext fails to decrypt (corruption /
  // keyring user change). getKey returns undefined; hasKey must NOT report true off the raw string.
  it('hasKey agrees with getKey when stored ciphertext fails to decrypt', () => {
    const throwingDecrypt: Encryptor = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from('ENC:' + plain, 'utf8'),
      decryptString: () => {
        throw new Error('decrypt failed (corrupt ciphertext)')
      }
    }
    // Seed a valid-JSON file with a non-empty base64 entry (the split-brain precondition).
    writeFileSync(
      join(dir, 'llm-keys.json'),
      JSON.stringify({ openrouter: Buffer.from('garbage', 'utf8').toString('base64') }),
      'utf8'
    )
    const store = createKeyStore(dir, throwingDecrypt)
    expect(store.getKey('openrouter')).toBeUndefined()
    expect(store.hasKey('openrouter')).toBe(false) // agrees: not a misleading true
  })
})

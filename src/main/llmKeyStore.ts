/**
 * T-B2: the encrypted API-key store for the LLM brain. Keys are encrypted via an injected
 * Encryptor (the real wiring passes Electron's safeStorage from index.ts) and persisted to
 * `userData/llm-keys.json` — NEVER the project folder / .canvas/ / canvas.json. Electron-free
 * by design (the Encryptor is injected) so this unit-tests without Electron, mirroring how
 * llmConfig takes an explicit userDataDir. The key is write-only into MAIN: this module exposes
 * only presence (hasKey) to IPC callers; the never-across-IPC rule is enforced by llmService.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { ProviderName } from './llmConfig'

/** Mirrors Electron safeStorage's surface so the real one drops in unchanged. */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface KeyStore {
  /** Decrypted key for a provider, or undefined if none stored / unreadable. */
  getKey(provider: ProviderName): string | undefined
  /** Encrypt + persist. Returns false (and writes nothing) if encryption is unavailable. */
  setKey(provider: ProviderName, key: string): boolean
  clearKey(provider: ProviderName): void
  /** Presence — true only when a stored key for the provider actually DECRYPTS (BUG-005: this
   *  must agree with getKey; a present-but-undecryptable entry reports false, not true). */
  hasKey(provider: ProviderName): boolean
}

type KeyFile = Partial<Record<ProviderName, string>> // provider → base64(ciphertext)

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'llm-keys.json')
}

function readFile(userDataDir: string): KeyFile {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as KeyFile) : {}
  } catch {
    return {}
  }
}

function writeFile(userDataDir: string, data: KeyFile): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(data, null, 2), 'utf8')
}

export function createKeyStore(userDataDir: string, encryptor: Encryptor): KeyStore {
  /**
   * Decrypt the stored entry for a provider, or undefined when ABSENT. A present-but-undecryptable
   * entry (BUG-005) is a DISTINCT state from "no key": it happens when the OS keyring became
   * unavailable after the key was written, or the ciphertext is tampered/corrupt. We surface that
   * distinction with a safe warning (provider name only — NEVER the entry bytes or key material)
   * so a silently-vanishing provider is diagnosable, and `hasKey`/`getKey` agree on "present" by
   * both routing through this one decrypt — closing the hasKey:true / getKey:undefined split-brain.
   */
  function tryDecrypt(provider: ProviderName): string | undefined {
    const enc = readFile(userDataDir)[provider]
    if (!enc) return undefined // genuinely absent
    if (!encryptor.isEncryptionAvailable()) {
      console.warn(
        `[llmKeyStore] stored key for "${provider}" exists but encryption is unavailable — cannot decrypt (key inaccessible, not absent)`
      )
      return undefined
    }
    try {
      return encryptor.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      console.warn(
        `[llmKeyStore] stored key for "${provider}" failed to decrypt (corrupt ciphertext or keyring change) — treating as inaccessible`
      )
      return undefined
    }
  }
  return {
    getKey(provider) {
      return tryDecrypt(provider)
    },
    setKey(provider, key) {
      if (!encryptor.isEncryptionAvailable()) return false
      const data = readFile(userDataDir)
      data[provider] = encryptor.encryptString(key).toString('base64')
      writeFile(userDataDir, data)
      return true
    },
    clearKey(provider) {
      const data = readFile(userDataDir)
      if (data[provider] === undefined) return
      delete data[provider]
      writeFile(userDataDir, data)
    },
    hasKey(provider) {
      // BUG-005: "present" must mean the SAME thing for hasKey and getKey, or llm:status reports
      // hasKey:true while getProvider returns null (split-brain). Route through the shared decrypt
      // so a present-but-undecryptable entry (keyring gone / corrupt ciphertext) reports false,
      // not a misleading true. tryDecrypt logs the absent-vs-inaccessible distinction safely.
      return tryDecrypt(provider) !== undefined
    }
  }
}

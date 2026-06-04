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
  /** Presence only — true when a non-empty entry exists for the provider. */
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
  return {
    getKey(provider) {
      const enc = readFile(userDataDir)[provider]
      if (!enc) return undefined
      try {
        return encryptor.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        return undefined
      }
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
      const enc = readFile(userDataDir)[provider]
      return typeof enc === 'string' && enc.length > 0
    }
  }
}

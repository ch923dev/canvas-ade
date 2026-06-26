/**
 * Phase 1 (accounts): the encrypted store for cloud-account OAuth tokens. The token bundle
 * (access + refresh + expiry) is encrypted via an injected Encryptor (the real wiring passes
 * Electron's safeStorage from index.ts) and persisted to `userData/auth-tokens.json` — NEVER the
 * project folder / .canvas/. Electron-free by design (the Encryptor is injected) so this unit-tests
 * without Electron, mirroring llmKeyStore. Tokens are write-only into MAIN: only presence
 * (hasTokens) is surfaced to IPC callers — the never-across-IPC rule holds, like the API-key store.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { Encryptor } from './llmKeyStore'

export interface TokenBundle {
  accessToken: string
  refreshToken: string
  /** Access-token expiry, epoch ms. */
  expiresAt: number
}

export interface AuthTokenStore {
  /** Decrypted token bundle, or undefined if none stored / unreadable. */
  getTokens(): TokenBundle | undefined
  /** Encrypt + persist the bundle. Returns false (and writes nothing) when encryption is unavailable. */
  setTokens(bundle: TokenBundle): boolean
  clearTokens(): void
  /** Presence — true only when a stored bundle actually DECRYPTS (must agree with getTokens). */
  hasTokens(): boolean
}

type TokenFile = { bundle?: string } // base64(ciphertext of the JSON-encoded TokenBundle)

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'auth-tokens.json')
}

function readFile(userDataDir: string): TokenFile {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as TokenFile) : {}
  } catch {
    return {}
  }
}

function writeFile(userDataDir: string, data: TokenFile): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(data, null, 2), 'utf8')
}

function isBundle(v: unknown): v is TokenBundle {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    typeof b.accessToken === 'string' &&
    typeof b.refreshToken === 'string' &&
    typeof b.expiresAt === 'number'
  )
}

export function createAuthTokenStore(userDataDir: string, encryptor: Encryptor): AuthTokenStore {
  /**
   * Decrypt the stored bundle, or undefined when ABSENT or INACCESSIBLE. Like llmKeyStore.tryDecrypt,
   * a present-but-undecryptable entry (keyring gone after write, or corrupt ciphertext) is a DISTINCT
   * state from "no tokens"; we surface it with a safe warning (NEVER any token bytes) so getTokens and
   * hasTokens always agree on "present" by both routing through this single decrypt.
   */
  function tryDecrypt(): TokenBundle | undefined {
    const enc = readFile(userDataDir).bundle
    if (!enc) return undefined // genuinely absent
    if (!encryptor.isEncryptionAvailable()) {
      console.warn(
        '[authTokenStore] stored tokens exist but encryption is unavailable — cannot decrypt (tokens inaccessible, not absent)'
      )
      return undefined
    }
    try {
      const parsed = JSON.parse(encryptor.decryptString(Buffer.from(enc, 'base64'))) as unknown
      return isBundle(parsed) ? parsed : undefined
    } catch {
      console.warn(
        '[authTokenStore] stored tokens failed to decrypt (corrupt ciphertext or keyring change) — treating as inaccessible'
      )
      return undefined
    }
  }
  return {
    getTokens() {
      return tryDecrypt()
    },
    setTokens(bundle) {
      if (!encryptor.isEncryptionAvailable()) return false
      writeFile(userDataDir, {
        bundle: encryptor.encryptString(JSON.stringify(bundle)).toString('base64')
      })
      return true
    },
    clearTokens() {
      if (readFile(userDataDir).bundle === undefined) return
      writeFile(userDataDir, {})
    },
    hasTokens() {
      // Route through the shared decrypt so a present-but-undecryptable bundle reports false (not a
      // misleading true) — the same split-brain guard llmKeyStore.hasKey applies (BUG-005).
      return tryDecrypt() !== undefined
    }
  }
}

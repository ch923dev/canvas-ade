/**
 * Phase 1 (accounts): the NON-SECRET cloud-account session record — { userId, email, expiresAt,
 * plan } — persisted to `userData/session.json` (NEVER a project folder). The auth TOKENS are NOT
 * stored here (authTokenStore encrypts those via safeStorage); this file holds only the identity
 * fields that are safe to read back for the UI. Pure file I/O keyed by an explicit userDataDir so it
 * unit-tests without Electron's `app`. Mirrors llmConfig.ts.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export type Plan = 'free' | 'pro'

export interface SessionInfo {
  /** WorkOS `sub` — the immutable user id (never key on email, which can change/recycle). */
  userId: string
  email: string
  /** Session/refresh-window expiry, epoch ms. */
  expiresAt: number
  plan: Plan
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'session.json')
}

/** Read the persisted session, or null when absent / unreadable / missing required identity. */
export function readSession(userDataDir: string): SessionInfo | null {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return null
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Partial<SessionInfo>
    // Identity is required: a record without a userId/email is treated as signed-out (null), which
    // is also how clearSession() leaves the file (an empty object) without an unlink race.
    if (typeof p.userId !== 'string' || p.userId.length === 0) return null
    if (typeof p.email !== 'string' || p.email.length === 0) return null
    const plan: Plan = p.plan === 'pro' ? 'pro' : 'free'
    const expiresAt =
      typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt) ? p.expiresAt : 0
    return { userId: p.userId, email: p.email, expiresAt, plan }
  } catch {
    return null
  }
}

/** Persist the session record. Atomic write (write-file-atomic), like llmConfig. */
export function writeSession(userDataDir: string, session: SessionInfo): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(session, null, 2), 'utf8')
}

/**
 * Clear the persisted session (→ signed out). Writes an empty object rather than unlinking, so a
 * concurrent reader never sees a half-removed file; readSession treats a record missing
 * userId/email as null. No-op when the file is already absent.
 */
export function clearSession(userDataDir: string): void {
  if (!existsSync(fileFor(userDataDir))) return
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify({}, null, 2), 'utf8')
}

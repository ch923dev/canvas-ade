/**
 * Phase 1 (accounts): the cached subscription entitlement, persisted to `userData/entitlement.json`
 * (NEVER a project folder). Stripe (Phase 2) is the source of truth; this is a cache the desktop
 * reads at startup so feature gating resolves instantly and survives brief offline periods. Pure
 * file I/O keyed by an explicit userDataDir (no Electron) → unit-testable. Mirrors llmConfig.ts.
 *
 * Offline grace: callers use isFresh() to decide whether to trust the cache or re-check the backend;
 * when the network is unreachable they fall back to the cache rather than hard-blocking a paying
 * user. In Phase 1 the backend stub always returns `free`, so this just round-trips the default.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { Plan } from './authSession'

export type SubStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'

export interface Entitlement {
  plan: Plan
  status: SubStatus
  /** End of the current paid period, epoch ms, or null when not applicable (free / never paid). */
  currentPeriodEnd: number | null
  /** When this cache was last confirmed against the backend, epoch ms (0 = never checked). */
  checkedAt: number
}

const SUB_STATUSES: SubStatus[] = ['active', 'trialing', 'past_due', 'canceled', 'none']

/** The safe default for a machine with no (or unreadable) cached entitlement: free, never-checked. */
export function freeEntitlement(): Entitlement {
  return { plan: 'free', status: 'none', currentPeriodEnd: null, checkedAt: 0 }
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'entitlement.json')
}

/** Read the cached entitlement, repairing unknown fields. Returns the free default when absent. */
export function readEntitlement(userDataDir: string): Entitlement {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return freeEntitlement()
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Partial<Entitlement>
    const plan: Plan = p.plan === 'pro' ? 'pro' : 'free'
    const status: SubStatus = SUB_STATUSES.includes(p.status as SubStatus)
      ? (p.status as SubStatus)
      : 'none'
    const currentPeriodEnd =
      typeof p.currentPeriodEnd === 'number' && Number.isFinite(p.currentPeriodEnd)
        ? p.currentPeriodEnd
        : null
    const checkedAt =
      typeof p.checkedAt === 'number' && Number.isFinite(p.checkedAt) && p.checkedAt >= 0
        ? p.checkedAt
        : 0
    return { plan, status, currentPeriodEnd, checkedAt }
  } catch {
    return freeEntitlement()
  }
}

/** Persist the entitlement cache. Atomic write (write-file-atomic), like llmConfig. */
export function writeEntitlement(userDataDir: string, ent: Entitlement): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(ent, null, 2), 'utf8')
}

/** Reset the cache to the free default (→ on sign-out). */
export function clearEntitlement(userDataDir: string): void {
  writeEntitlement(userDataDir, freeEntitlement())
}

/**
 * Is the cache fresh enough to trust without a network re-check? `now` and `ttlMs` are injected so
 * this stays deterministic in tests. A never-checked cache (checkedAt 0) is never fresh.
 */
export function isFresh(ent: Entitlement, ttlMs: number, now: number): boolean {
  return ent.checkedAt > 0 && now - ent.checkedAt < ttlMs
}

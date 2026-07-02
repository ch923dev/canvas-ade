import { describe, it, expect } from 'vitest'
import { createAuthService, type AuthServiceDeps, type AuthStatus } from './authService'
import type { AuthTokenStore, TokenBundle } from './authTokenStore'
import type { SessionInfo } from './authSession'
import { freeEntitlement, type Entitlement } from './entitlementCache'
import type { FetchLike } from './workosAuth'

const config = {
  clientId: 'client_test',
  redirectUri: 'expanse://auth/callback',
  licenseUrl: 'https://example.functions.supabase.co/license'
}

function makeTokenStore(): AuthTokenStore {
  let bundle: TokenBundle | undefined
  return {
    getTokens: () => bundle,
    setTokens: (b) => {
      bundle = b
      return true
    },
    clearTokens: () => {
      bundle = undefined
    },
    hasTokens: () => bundle !== undefined
  }
}

function makeHarness(over: Partial<AuthServiceDeps> = {}): {
  deps: AuthServiceDeps
  opened: string[]
  statuses: AuthStatus[]
  tokenStore: AuthTokenStore
  getSession: () => SessionInfo | null
} {
  const opened: string[] = []
  const statuses: AuthStatus[] = []
  const tokenStore = makeTokenStore()
  let session: SessionInfo | null = null
  let entitlement: Entitlement = freeEntitlement()

  // Routes the two POST/GET calls by URL: the WorkOS exchange + the Supabase license check.
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('/authenticate')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { id: 'user_1', email: 'a@b.com' },
          access_token: 'at',
          refresh_token: 'rt'
        }),
        text: async () => ''
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ active: true, plan: 'free' }),
      text: async () => ''
    }
  }

  const deps: AuthServiceDeps = {
    config,
    tokenStore,
    session: {
      read: () => session,
      write: (s) => {
        session = s
      },
      clear: () => {
        session = null
      }
    },
    entitlement: {
      read: () => entitlement,
      write: (e) => {
        entitlement = e
      },
      clear: () => {
        entitlement = freeEntitlement()
      }
    },
    openExternal: (u) => opened.push(u),
    encryptionAvailable: () => true,
    onStatusChanged: (s) => statuses.push(s),
    fetchImpl,
    now: () => 1000,
    ...over
  }
  return { deps, opened, statuses, tokenStore, getSession: () => session }
}

function stateFromUrl(url: string): string {
  return new URL(url).searchParams.get('state') ?? ''
}

describe('createAuthService', () => {
  it('signIn opens a WorkOS authorize URL with the configured client + redirect', () => {
    const { deps, opened } = makeHarness()
    const svc = createAuthService(deps)
    expect(svc.signIn()).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
    const u = new URL(opened[0])
    expect(u.origin + u.pathname).toBe('https://api.workos.com/user_management/authorize')
    expect(u.searchParams.get('client_id')).toBe('client_test')
    expect(u.searchParams.get('redirect_uri')).toBe('expanse://auth/callback')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('refuses to sign in when encryption is unavailable (no plaintext tokens)', () => {
    const { deps, opened } = makeHarness({ encryptionAvailable: () => false })
    const svc = createAuthService(deps)
    expect(svc.signIn()).toEqual({ ok: false })
    expect(opened).toHaveLength(0)
  })

  it('completes the happy path: state-match → exchange → store → status push', async () => {
    const { deps, opened, statuses, tokenStore, getSession } = makeHarness()
    const svc = createAuthService(deps)
    svc.signIn()
    await svc.handleCallback(`expanse://auth/callback?code=CODE&state=${stateFromUrl(opened[0])}`)
    expect(tokenStore.hasTokens()).toBe(true)
    expect(getSession()?.email).toBe('a@b.com')
    expect(statuses[statuses.length - 1]).toMatchObject({
      isLoggedIn: true,
      email: 'a@b.com',
      plan: 'free'
    })
  })

  it('rejects a callback whose state does not match a pending sign-in (no exchange)', async () => {
    const { deps, tokenStore } = makeHarness()
    const svc = createAuthService(deps)
    svc.signIn()
    await svc.handleCallback('expanse://auth/callback?code=CODE&state=forged-state')
    expect(tokenStore.hasTokens()).toBe(false)
  })

  it('ignores a non-expanse callback URL', async () => {
    const { deps, tokenStore } = makeHarness()
    const svc = createAuthService(deps)
    svc.signIn()
    await svc.handleCallback('https://evil.example/callback?code=CODE&state=x')
    expect(tokenStore.hasTokens()).toBe(false)
  })

  it('status() reports signed-out when the session outlives the token store (BUG-025)', async () => {
    const { deps, opened, tokenStore } = makeHarness()
    const svc = createAuthService(deps)
    svc.signIn()
    await svc.handleCallback(`expanse://auth/callback?code=CODE&state=${stateFromUrl(opened[0])}`)
    expect(svc.status().isLoggedIn).toBe(true)
    // Simulate the token store losing its tokens (cleared/undecryptable) while the session file
    // survives — status() must not trust the session file alone.
    tokenStore.clearTokens()
    expect(svc.status()).toMatchObject({ isLoggedIn: false })
  })

  it('signOut clears tokens + session + entitlement and pushes signed-out', async () => {
    const { deps, opened, statuses, tokenStore, getSession } = makeHarness()
    const svc = createAuthService(deps)
    svc.signIn()
    await svc.handleCallback(`expanse://auth/callback?code=CODE&state=${stateFromUrl(opened[0])}`)
    expect(tokenStore.hasTokens()).toBe(true)
    await svc.signOut()
    expect(tokenStore.hasTokens()).toBe(false)
    expect(getSession()).toBeNull()
    expect(statuses[statuses.length - 1]).toMatchObject({ isLoggedIn: false })
  })

  // BUG-024: entitlementCache.isFresh() was defined but never consulted by any caller, so a
  // cached entitlement was trusted indefinitely once written at sign-in — a Stripe-side
  // cancel/lapse would never reach the desktop.
  describe('syncEntitlementIfStale', () => {
    it('is a no-op when signed out', async () => {
      const { deps, statuses } = makeHarness()
      const svc = createAuthService(deps)
      await svc.syncEntitlementIfStale(1000)
      expect(statuses).toHaveLength(0)
    })

    it('is a no-op when the cached entitlement is still fresh', async () => {
      let nowMs = 1000
      const { deps, opened, statuses } = makeHarness({ now: () => nowMs })
      const svc = createAuthService(deps)
      svc.signIn()
      await svc.handleCallback(`expanse://auth/callback?code=CODE&state=${stateFromUrl(opened[0])}`)
      const pushesAfterSignIn = statuses.length
      nowMs += 500 // well within a 1000ms TTL
      await svc.syncEntitlementIfStale(1000)
      expect(statuses).toHaveLength(pushesAfterSignIn) // no re-check → no extra status push
    })

    it('re-checks the license endpoint and updates the plan once the cache goes stale', async () => {
      let nowMs = 1000
      let planReturned: 'free' | 'pro' = 'free'
      const fetchImpl: FetchLike = async (url) => {
        if (url.includes('/authenticate')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              user: { id: 'user_1', email: 'a@b.com' },
              access_token: 'at',
              refresh_token: 'rt'
            }),
            text: async () => ''
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ active: planReturned === 'pro', plan: planReturned }),
          text: async () => ''
        }
      }
      const { deps, opened, statuses } = makeHarness({ now: () => nowMs, fetchImpl })
      const svc = createAuthService(deps)
      svc.signIn()
      await svc.handleCallback(`expanse://auth/callback?code=CODE&state=${stateFromUrl(opened[0])}`)
      expect(statuses[statuses.length - 1]).toMatchObject({ plan: 'free' })

      // The subscription changed server-side after the initial check.
      planReturned = 'pro'
      nowMs += 2000 // past a 1000ms TTL
      await svc.syncEntitlementIfStale(1000)
      expect(statuses[statuses.length - 1]).toMatchObject({ plan: 'pro' })
    })
  })
})

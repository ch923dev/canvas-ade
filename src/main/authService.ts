/**
 * Phase 1 (accounts): the MAIN-process sign-in orchestrator. Ties together the WorkOS PKCE helpers
 * (workosAuth), the encrypted token store + session + entitlement cache (steps 1-2), the system
 * browser, and the entitlement (license) fetch. Every side-effecting dependency is injected, so the
 * whole flow unit-tests without Electron or the network.
 *
 * Flow: signIn() generates a PKCE pair + a `state` nonce, stashes the verifier in an in-memory Map
 * (5-min TTL — never persisted, never sent over IPC), and opens the WorkOS authorize URL in the
 * system browser. The OS routes the expanse:// callback back to MAIN (index.ts) → handleCallback()
 * validates the state, exchanges code→tokens, persists them, fetches the entitlement, and pushes the
 * new status to the renderer.
 *
 * SECURITY: the PKCE verifier + state live ONLY in this Map; tokens go to the encrypted store and
 * NEVER cross IPC (status carries presence/email/plan only).
 */
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  decodeJwtExp,
  exchangeCodeForTokens,
  type FetchLike
} from './workosAuth'
import type { AuthTokenStore } from './authTokenStore'
import type { Plan, SessionInfo } from './authSession'
import type { Entitlement } from './entitlementCache'
import type { AuthConfig } from './authConfig'

/** What the renderer is allowed to know about auth — presence + email + plan only, NEVER a token. */
export interface AuthStatus {
  isLoggedIn: boolean
  email?: string
  plan?: Plan
  encryptionAvailable: boolean
}

export interface AuthServiceDeps {
  config: AuthConfig
  tokenStore: AuthTokenStore
  session: {
    read: () => SessionInfo | null
    write: (s: SessionInfo) => void
    clear: () => void
  }
  entitlement: {
    read: () => Entitlement
    write: (e: Entitlement) => void
    clear: () => void
  }
  /** Open a URL in the system browser (shell.openExternal via openExternalSafe). */
  openExternal: (url: string) => void
  /** Whether safeStorage can encrypt — if not, sign-in is blocked (no plaintext tokens). */
  encryptionAvailable: () => boolean
  /** Pushed to the renderer on every auth state change. */
  onStatusChanged: (status: AuthStatus) => void
  fetchImpl?: FetchLike
  now?: () => number
}

export interface AuthService {
  status(): AuthStatus
  signIn(): { ok: boolean }
  signOut(): Promise<{ ok: boolean }>
  /** Called by the MAIN deep-link handlers (open-url / second-instance) with the callback URL. */
  handleCallback(url: string): Promise<void>
}

const FIVE_MIN_MS = 5 * 60 * 1000

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = deps.now ?? ((): number => Date.now())
  // state → { verifier, createdAt }. In-memory ONLY; never persisted, never sent over IPC.
  const pending = new Map<string, { verifier: string; createdAt: number }>()

  function prunePending(): void {
    for (const [k, v] of pending) {
      if (now() - v.createdAt > FIVE_MIN_MS) pending.delete(k)
    }
  }

  function status(): AuthStatus {
    const encryptionAvailable = deps.encryptionAvailable()
    const s = deps.session.read()
    if (!s) return { isLoggedIn: false, encryptionAvailable }
    return {
      isLoggedIn: true,
      email: s.email,
      plan: deps.entitlement.read().plan,
      encryptionAvailable
    }
  }

  function signIn(): { ok: boolean } {
    // No keyring → we can't store tokens; refuse rather than leave a half-signed-in state.
    if (!deps.encryptionAvailable()) return { ok: false }
    prunePending()
    const { verifier, challenge } = createPkcePair()
    const state = createState()
    pending.set(state, { verifier, createdAt: now() })
    deps.openExternal(
      buildAuthorizeUrl({
        clientId: deps.config.clientId,
        redirectUri: deps.config.redirectUri,
        codeChallenge: challenge,
        state
      })
    )
    return { ok: true }
  }

  async function refreshEntitlement(accessToken: string): Promise<void> {
    try {
      const res = await fetchImpl(deps.config.licenseUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      if (!res.ok) return // keep the cached entitlement; never hard-block on a license hiccup
      const body = (await res.json()) as { active?: boolean; plan?: string }
      const plan: Plan = body.plan === 'pro' ? 'pro' : 'free'
      deps.entitlement.write({
        ...deps.entitlement.read(),
        plan,
        status: body.active ? (plan === 'pro' ? 'active' : 'none') : 'none',
        checkedAt: now()
      })
    } catch {
      // Offline / fetch error → keep the cached entitlement (offline grace). Never throw.
    }
  }

  async function handleCallback(rawUrl: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }
    if (parsed.protocol !== 'expanse:') return
    const state = parsed.searchParams.get('state')
    const code = parsed.searchParams.get('code')
    if (!state || !code) return
    const entry = pending.get(state)
    pending.delete(state)
    // Unknown or expired state = a replay / CSRF / stale link → reject without exchanging.
    if (!entry || now() - entry.createdAt > FIVE_MIN_MS) {
      console.warn('[auth] callback state did not match a fresh pending sign-in — ignoring')
      return
    }
    try {
      const result = await exchangeCodeForTokens(
        { clientId: deps.config.clientId, code, codeVerifier: entry.verifier },
        fetchImpl
      )
      const expiresAt = decodeJwtExp(result.accessToken) ?? now() + 60 * 60 * 1000
      const stored = deps.tokenStore.setTokens({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt
      })
      if (!stored) {
        console.error('[auth] could not store tokens (encryption unavailable)')
        deps.onStatusChanged(status())
        return
      }
      deps.session.write({
        userId: result.user.id,
        email: result.user.email,
        expiresAt,
        plan: 'free'
      })
      await refreshEntitlement(result.accessToken)
      deps.onStatusChanged(status())
    } catch (err) {
      console.error('[auth] sign-in failed', err)
      deps.onStatusChanged(status())
    }
  }

  async function signOut(): Promise<{ ok: boolean }> {
    // Phase 1 sign-out = clear local state (the access token is short-lived). WorkOS server-side
    // session revocation can be added later.
    deps.tokenStore.clearTokens()
    deps.session.clear()
    deps.entitlement.clear()
    deps.onStatusChanged(status())
    return { ok: true }
  }

  return { status, signIn, signOut, handleCallback }
}

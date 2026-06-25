/**
 * Phase 1 (accounts): WorkOS AuthKit PKCE helpers for the desktop sign-in. The app is a PUBLIC
 * client — there is NO API secret. The authorize URL is opened in the system browser; the
 * code→token exchange runs HERE in MAIN via Node `fetch` with the `code_verifier` (PKCE) + the
 * public Client ID only. Pure / Electron-free so the PKCE math + URL building unit-test directly;
 * the exchange takes an injected fetch for tests.
 *
 * Endpoints (WorkOS User Management), confirmed 2026-06-26 against workos/electron-authkit-example +
 * the API reference:
 *   - GET  https://api.workos.com/user_management/authorize
 *   - POST https://api.workos.com/user_management/authenticate   (PKCE: code_verifier, NO secret)
 * (The request below sends JSON; if WorkOS rejects it at live-wire time, switch to form-encoding —
 * field names are unchanged.)
 */
import { createHash, randomBytes } from 'crypto'

const AUTHORIZE_URL = 'https://api.workos.com/user_management/authorize'
const TOKEN_URL = 'https://api.workos.com/user_management/authenticate'

/** base64url (RFC 4648 §5, no padding) of a buffer. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** Generate a PKCE verifier (32 random bytes → 43-char base64url) + its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** A CSRF/replay nonce for the OAuth `state` param (16 random bytes → base64url). */
export function createState(): string {
  return base64url(randomBytes(16))
}

export interface AuthorizeUrlParams {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  /** AuthKit hosted UI (default) or a specific provider. */
  provider?: string
  screenHint?: 'sign-in' | 'sign-up'
}

/** Build the WorkOS authorize URL to open in the system browser. */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('client_id', p.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('code_challenge', p.codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('provider', p.provider ?? 'authkit')
  u.searchParams.set('state', p.state)
  if (p.screenHint) u.searchParams.set('screen_hint', p.screenHint)
  return u.toString()
}

export interface WorkosUser {
  id: string
  email: string
}

export interface AuthResult {
  user: WorkosUser
  accessToken: string
  refreshToken: string
}

/** The minimal fetch surface this module uses — injectable so the exchange unit-tests without network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

/**
 * Exchange an authorization code + PKCE verifier for tokens. Public PKCE client → `client_id` only,
 * NO `client_secret`. `fetchImpl` is injected for tests (defaults to MAIN's global fetch).
 */
export async function exchangeCodeForTokens(
  args: { clientId: string; code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<AuthResult> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: args.clientId,
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.codeVerifier
    })
  })
  if (!res.ok) {
    throw new Error(`WorkOS token exchange failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as {
    user?: { id?: string; email?: string }
    access_token?: string
    refresh_token?: string
  }
  if (!data.user?.id || !data.user.email || !data.access_token || !data.refresh_token) {
    throw new Error('WorkOS token exchange returned an unexpected response shape')
  }
  return {
    user: { id: data.user.id, email: data.user.email },
    accessToken: data.access_token,
    refreshToken: data.refresh_token
  }
}

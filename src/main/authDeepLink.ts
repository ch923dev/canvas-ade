/**
 * Phase 1 (accounts): parse + validate the OAuth deep-link callback routed back into the app from
 * the system browser (expanse://auth/callback?code=...&state=...). Pure + Electron-free so it
 * unit-tests directly. Step 3 is LOG-ONLY (no token exchange yet); step 4 adds PKCE `state` matching
 * + the MAIN-only code→token exchange.
 *
 * SECURITY: callers must NEVER log or forward the query string — it carries the auth code + state.
 * The query is intentionally dropped from the returned shape here; only host/path are safe to surface.
 */
export interface AuthDeepLink {
  /** The URL authority, e.g. 'auth' for expanse://auth/callback. */
  host: string
  /** The URL path, e.g. '/callback'. */
  path: string
}

/** The only host/path this app treats as an auth callback (expanse://auth/callback). */
const AUTH_CALLBACK_HOST = 'auth'
const AUTH_CALLBACK_PATH = '/callback'

/**
 * Validate the custom scheme AND the host/path route. Returns null for a non-expanse / malformed
 * URL, or for an expanse:// URL that doesn't match the auth-callback route — fail closed, since the
 * caller forwards the result straight into the auth-callback handler.
 */
export function parseAuthDeepLink(url: string): AuthDeepLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'expanse:') return null
  if (parsed.host !== AUTH_CALLBACK_HOST || parsed.pathname !== AUTH_CALLBACK_PATH) return null
  return { host: parsed.host, path: parsed.pathname }
}

/** Find the first expanse:// deep-link in a process / second-instance argv array, if present. */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((a) => a.startsWith('expanse://'))
}

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

/** Validate the custom scheme and extract host/path. Returns null for a non-expanse / malformed URL. */
export function parseAuthDeepLink(url: string): AuthDeepLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'expanse:') return null
  return { host: parsed.host, path: parsed.pathname }
}

/** Find the first expanse:// deep-link in a process / second-instance argv array, if present. */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((a) => a.startsWith('expanse://'))
}

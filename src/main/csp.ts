/**
 * Content-Security-Policy strings for the renderer + the pure meta-injection the
 * `canvas-ade-csp-meta` vite plugin (electron.vite.config.ts) applies at build time. Kept as a
 * standalone, dependency-free module so the policy — the app's main XSS backstop — is
 * unit-testable and can't silently regress (csp.test.ts). It is NOT imported by the app runtime;
 * only the build config consumes it, so it never lands in the main/renderer bundle.
 *
 * - DEV keeps `script-src 'unsafe-inline'` — Vite's React-refresh preamble + @vite/client are
 *   injected as inline scripts with no nonce hook.
 * - PROD drops it → `script-src 'self'`: the built HTML's only script is the external hashed
 *   module bundle, so inline-script injection (the real XSS vector) is blocked.
 * - `style-src` keeps `'unsafe-inline'` in BOTH: React inline `style={{}}` attributes (and xterm's
 *   runtime element styles) are pervasive and CSP nonces can't authorize inline style ATTRIBUTES.
 * - `object-src 'none'` / `base-uri 'self'` / `frame-ancestors 'none'` are hardening backstops
 *   safe in both modes (no <object>/<embed>, no <base> injection, never framed — a desktop app).
 *   Never weaken contextIsolation/sandbox/nodeIntegration to relax these.
 */
const HARDENING = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

export const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*; " +
  HARDENING

export const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
  HARDENING

/** Replace the index.html CSP <meta> content with the policy for the given mode. */
export function injectCspMeta(html: string, isDev: boolean): string {
  const csp = isDev ? DEV_CSP : PROD_CSP
  return html.replace(
    /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
    `$1${csp}$2`
  )
}

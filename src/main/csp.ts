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

/**
 * Scoped CSP for the HIDDEN diagram render worker ONLY (S4 — Mermaid Diagram element). Mermaid 11
 * needs `unsafe-eval` (dagre / `new Function` / its bundled layout engines); the worker is a
 * never-shown `BrowserWindow` (src/main/diagramWorker.ts) loading `resources/diagram-worker/
 * worker.html`, so this eval grant is confined to that one invisible window — the MAIN window's
 * PROD_CSP above stays `script-src 'self'` (no eval) and MUST NOT change to ship this feature.
 *
 * `'self'` resolves to the worker HTML's own directory (out/main/diagram-worker/), authorizing the
 * sibling vendored `mermaid.min.js`. `default-src 'none'` blocks ALL network — the single-file
 * Mermaid build is self-contained (zero dynamic chunk imports), so the worker renders fully offline
 * and an untrusted diagram source can never exfiltrate or pull remote code. `style-src
 * 'unsafe-inline'` is required (Mermaid injects a <style> block into the rendered SVG); `img-src
 * 'self' data:` covers any data-URI marker assets. SVG output is sanitized by Mermaid's
 * `securityLevel:'strict'` (DOMPurify) and ultimately displayed as an inert <img> in the renderer.
 *
 * This string is loaded as a <meta http-equiv="Content-Security-Policy"> in worker.html (a file://
 * page, where webRequest.onHeadersReceived is unreliable). csp.test.ts reads worker.html and
 * asserts its meta matches this constant, so csp.ts stays the single source of truth.
 */
export const DIAGRAM_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'"

const CSP_META_RE = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/

/**
 * Replace the index.html CSP <meta> content with the policy for the given mode.
 * THROWS if the meta tag is not found: index.html's fallback content is the DEV policy
 * (script-src 'unsafe-inline'), so a silent no-match here would ship the dev CSP in
 * packaged builds. The throw fails the vite build loudly instead. The regex requires
 * exactly `<meta http-equiv="Content-Security-Policy" content="...">` — double quotes,
 * that attribute order, no intervening attributes (whitespace/newlines are fine).
 */
export function injectCspMeta(html: string, isDev: boolean): string {
  if (!CSP_META_RE.test(html)) {
    throw new Error(
      'injectCspMeta: no CSP <meta http-equiv="Content-Security-Policy" content="..."> tag ' +
        'matched in index.html — refusing to silently ship the fallback (dev) policy. ' +
        'Restore the tag to that exact shape (double quotes, http-equiv before content).'
    )
  }
  const csp = isDev ? DEV_CSP : PROD_CSP
  return html.replace(CSP_META_RE, `$1${csp}$2`)
}

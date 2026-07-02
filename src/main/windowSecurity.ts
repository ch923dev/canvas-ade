/**
 * Pure, unit-testable security surface for the MAIN application window, extracted
 * from index.ts so the Electron security-checklist invariants can be asserted
 * without constructing a BrowserWindow. Covers #3 (context isolation), #4
 * (sandbox), and #13/#14 (navigation + new-window limits). The side effects
 * (creating the window, shell.openExternal, preventDefault) stay in index.ts;
 * these functions only compute the decisions.
 */
import { isAllowedExternal } from './previewShared'

/**
 * Security-critical webPreferences for the main window: contextIsolation +
 * sandbox ON, nodeIntegration + webviewTag OFF (#3/#4). The `preload` path is
 * runtime-specific (built from __dirname) so the caller supplies it.
 *
 * webSecurity / allowRunningInsecureContent / experimentalFeatures are pinned to their
 * safe defaults EXPLICITLY (implicit-secure-defaults-not-pinned): the same-origin policy
 * and insecure/experimental web surfaces must not be silently flippable by a later edit.
 */
export function buildMainWindowWebPreferences(preloadPath: string): {
  preload: string
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  webviewTag: false
  webSecurity: true
  allowRunningInsecureContent: false
  experimentalFeatures: false
} {
  return {
    preload: preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false
  }
}

/**
 * Whether the in-process renderer E2E test-surface (`window.__canvasE2E`, the terminal
 * registries in `e2eRegistry.ts`) should be enabled — a MAIN-owned decision (BUG-057). Renderer
 * code must gate on this (via the preload-exposed, contextBridge-frozen value), NOT on the
 * `?e2e=1` URL query alone: `window.location.search` is renderer-mutable (e.g. a script calling
 * `history.pushState`/`replaceState`), so a query-only gate lets any renderer-context script
 * self-enable a surface that exposes terminal I/O, project I/O, and board mutation. This pure
 * function is read ONCE, synchronously, by preload (`platformIpc.ts`'s `platform:e2eEnabled`
 * channel) and exposed as a frozen field — untouchable from the main-world renderer.
 */
export function computeE2ESurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CANVAS_E2E
}

/**
 * The main window's new-window policy (#14): ALWAYS deny in-app window
 * creation; hand an allowlisted-scheme URL (http/https/mailto) to the OS browser,
 * drop everything else. Pure — the caller performs shell.openExternal.
 */
export function windowOpenDecision(url: string): { action: 'deny'; openExternal: string | null } {
  return { action: 'deny', openExternal: isAllowedExternal(url) ? url : null }
}

/**
 * The app origin the main window is pinned to. Dev: the renderer dev-server's
 * origin. Packaged (no renderer URL): null — a packaged file: URL has the origin
 * string "null", matched against this null below.
 */
export function computeAppOrigin(rendererUrl: string | undefined): string | null {
  if (!rendererUrl) return null
  try {
    return new URL(rendererUrl).origin
  } catch {
    return null
  }
}

/**
 * Normalize a `file:` pathname for comparison. Percent-encoding (`%20`) is decoded
 * by reading `URL.pathname` upstream, but we also tolerate a raw encoded value here
 * by decoding once. On win32 the comparison is case-insensitive (NTFS/ConPTY paths
 * are case-insensitive) and on POSIX it is case-sensitive. Returns the input
 * untouched when it is null/undefined so callers can thread an absent appDocPath.
 */
export function normalizeDocPath<T extends string | null | undefined>(
  pathname: T,
  platform: NodeJS.Platform = process.platform
): T {
  if (pathname == null) return pathname
  // After the null guard `pathname` is the non-null branch of T; pin it to `string`
  // so the decoded reassignment type-checks (the `as T` restores the caller's type).
  const raw = pathname as string
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Malformed %-sequence — keep the raw value (it simply won't match the doc).
  }
  return (platform === 'win32' ? decoded.toLowerCase() : decoded) as T
}

/**
 * Same-frame navigation guard decision (#13): the main window must never navigate
 * away from its own document.
 *
 * - Non-`file:` URLs: compare ORIGIN (not the full URL) so the e2e `?e2e=1` query /
 *   in-app hash changes pass. A different origin is blocked; an allowlisted
 *   http(s)/mailto target is routed to the OS browser, everything else is dropped.
 * - `file:` URLs (packaged build): a `file:` URL's web origin is the opaque string
 *   "null", which can NOT distinguish the app's own `renderer/index.html` from any
 *   other local file (audit `packaged-fileurl-nav-allowed`). So we pin to the exact
 *   app document: allow IFF `appDocPath` is set AND the navigation target's
 *   normalized PATHNAME equals the normalized `appDocPath` (ignoring query/hash and,
 *   on win32, ASCII case). Any other `file:` URL is blocked and is NEVER routed to
 *   the OS browser (openExternal stays http(s)/mailto-only). In dev `appDocPath` is
 *   absent, so every `file:` URL is blocked — identical to the prior behaviour.
 */
export function navDecision(
  url: string,
  opts: { appOrigin: string | null; appDocPath?: string | null; platform?: NodeJS.Platform }
): { allow: boolean; openExternal: string | null } {
  const { appOrigin, appDocPath, platform } = opts
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { allow: false, openExternal: null }
  }
  if (u.protocol === 'file:') {
    // Pin to the exact app document; never hand a rejected local file to the OS.
    if (
      appDocPath != null &&
      normalizeDocPath(u.pathname, platform) === normalizeDocPath(appDocPath, platform)
    ) {
      return { allow: true, openExternal: null }
    }
    return { allow: false, openExternal: null }
  }
  if (u.origin === appOrigin) return { allow: true, openExternal: null }
  return { allow: false, openExternal: isAllowedExternal(url) ? url : null }
}

/**
 * Build the navigation-guard side effect (#13) from a navDecision predicate. The
 * returned handler is wired to the window's `will-navigate` / `will-redirect` /
 * `will-frame-navigate` events: an allowed target (same-origin nav, an in-app hash
 * change, or the app's own `location.reload()` — which re-navigates to the pinned
 * appDocPath/appOrigin) passes through untouched; a blocked target is
 * `preventDefault`'d, and an allowlisted http(s)/mailto URL is handed to the OS
 * browser. Extracted from index.ts so the event wiring — not just the predicate — is
 * unit-testable; index.ts injects the real `event.preventDefault` + `shell.openExternal`.
 */
export function createNavGuard(opts: {
  appOrigin: string | null
  appDocPath?: string | null
  platform?: NodeJS.Platform
  openExternal: (url: string) => void
}): (event: { preventDefault: () => void }, url: string) => void {
  const { appOrigin, appDocPath, platform, openExternal } = opts
  return (event, url) => {
    const d = navDecision(url, { appOrigin, appDocPath, platform })
    if (d.allow) return
    event.preventDefault()
    if (d.openExternal) openExternal(d.openExternal)
  }
}

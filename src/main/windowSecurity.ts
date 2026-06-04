/**
 * Pure, unit-testable security surface for the MAIN application window, extracted
 * from index.ts so the Electron security-checklist invariants can be asserted
 * without constructing a BrowserWindow. Covers #3 (context isolation), #4
 * (sandbox), and #13/#14 (navigation + new-window limits). The side effects
 * (creating the window, shell.openExternal, preventDefault) stay in index.ts;
 * these functions only compute the decisions.
 */
import { isAllowedExternal } from './preview'

/**
 * Security-critical webPreferences for the main window: contextIsolation +
 * sandbox ON, nodeIntegration + webviewTag OFF (#3/#4). The `preload` path is
 * runtime-specific (built from __dirname) so the caller supplies it.
 */
export function buildMainWindowWebPreferences(preloadPath: string): {
  preload: string
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  webviewTag: false
} {
  return {
    preload: preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false
  }
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
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
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

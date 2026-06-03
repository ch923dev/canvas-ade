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
 * Same-frame navigation guard decision (#13): the main window must never navigate
 * away from its own document. Compare ORIGIN (not the full URL) so the e2e
 * `?e2e=1` query / in-app hash changes pass. A file: URL has origin "null"
 * (represented here as `null`) → allowed against a null appOrigin (packaged). A
 * different origin is blocked; if it is an allowlisted http(s)/mailto target it is
 * routed to the OS browser, otherwise just dropped.
 */
export function navDecision(
  url: string,
  appOrigin: string | null
): { allow: boolean; openExternal: string | null } {
  let origin: string | null
  try {
    const u = new URL(url)
    origin = u.protocol === 'file:' ? null : u.origin
  } catch {
    return { allow: false, openExternal: null }
  }
  if (origin === appOrigin) return { allow: true, openExternal: null }
  return { allow: false, openExternal: isAllowedExternal(url) ? url : null }
}

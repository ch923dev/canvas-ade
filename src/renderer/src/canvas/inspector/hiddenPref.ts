/**
 * Inspector hide/retrieve persistence (P5-8) — the maintainer's "get it out of the way" toggle.
 * One app-level sticky flag (`ca.inspector.hidden`), same class as the section collapse prefs
 * (collapsePrefs.ts): per machine, all projects, NEVER routed into the board schema. Hidden stays
 * hidden across selections AND sessions until the user retrieves it from the left-edge tab.
 *
 * localStorage is read lazily (no module cache) so the e2e harness — which reuses a persistent
 * userData dir across specs — can reset by removing the key (e2eStickyPrefs). All access is
 * guarded: a storage failure degrades to session-local state, never throws.
 */

/** Key — `ca.` per the hintDismissal convention; swept by the e2e sticky reset. */
export const INSPECTOR_HIDDEN_KEY = 'ca.inspector.hidden'

/** Whether the user has hidden the Inspector (default false — shown). */
export function readHiddenPref(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the hide/retrieve choice. Hidden stores '1'; retrieving removes the key. */
export function writeHiddenPref(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(INSPECTOR_HIDDEN_KEY, '1')
    else window.localStorage.removeItem(INSPECTOR_HIDDEN_KEY)
  } catch {
    // Storage unavailable (quota/private mode) — the toggle still works for the session.
  }
}

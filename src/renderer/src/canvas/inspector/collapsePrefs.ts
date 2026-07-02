/**
 * Inspector section collapse persistence (P5) — the "later polish phase" the primitives
 * doc-comment promised. One localStorage key per section (`ca.inspector.collapse.<id>`),
 * app-level like the other sticky UI prefs (terminalFont / wayfindingStore / hintDismissal):
 * per machine, all projects, NEVER routed into the board schema.
 *
 * localStorage is read lazily (no module cache) so the e2e harness — which reuses a
 * persistent userData dir across specs — can reset by removing the keys (e2eHooks).
 * All access is guarded: a storage failure degrades to session-local state, never throws.
 */

/** Key prefix — `ca.` per the hintDismissal convention; the e2e reset sweeps this prefix. */
export const COLLAPSE_KEY_PREFIX = 'ca.inspector.collapse.'

/** The persisted open/closed choice for a section, or null when the user never toggled it
 *  (callers then fall back to the section's `defaultOpen`). */
export function readCollapsePref(persistKey: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY_PREFIX + persistKey)
    if (raw === '1') return true
    if (raw === '0') return false
    return null
  } catch {
    return null
  }
}

/** Persist a toggle. `open=true` stores '1' (expanded), `false` stores '0' (collapsed). */
export function writeCollapsePref(persistKey: string, open: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY_PREFIX + persistKey, open ? '1' : '0')
  } catch {
    // Storage unavailable (quota/private mode) — the section still toggles for the session.
  }
}

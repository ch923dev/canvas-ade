/**
 * First-run launchCommand hint — sticky dismissal state (design-audit D2-B, artifact
 * signed off 2026-06-11). The hint shows on a bare-shell terminal (no `launchCommand`)
 * until the user either sets a launch command (per board, handled by the caller) or
 * dismisses the pill — and a dismissal is APP-WIDE AND FOREVER (localStorage), per the
 * sign-off: this is a first-run teaching line, not a per-board notice.
 *
 * localStorage is read lazily (no module cache) so the e2e harness — which reuses a
 * persistent userData dir across runs — can clear the key between specs without needing
 * a module reload. Same-window reactivity (dismissing on board A hides board B's pill
 * immediately) comes from the tiny subscriber set + `useSyncExternalStore` in the pill.
 * (Named hintDismissal, not terminalHint: a `terminalHint.ts` would collide with
 * `TerminalHint.tsx` on Windows' case-insensitive filesystem — TS1261.)
 */

export const TERMINAL_HINT_KEY = 'ca.terminal.hintDismissed'

const subs = new Set<() => void>()

// In-memory fallback, set ONLY when the sticky write fails (quota path): without it,
// the lazy re-read below would return false after a failed setItem and the × click
// would visibly do nothing. Never set on the success path — the lazy-read e2e reset
// affordance (clear the key, no reload) stays intact.
let sessionFallback = false

/** True once the user has dismissed the hint anywhere (sticky, app-wide). */
export function isHintDismissed(): boolean {
  if (sessionFallback) return true
  try {
    return window.localStorage.getItem(TERMINAL_HINT_KEY) === '1'
  } catch {
    return false // storage unavailable → keep showing; never throw into render
  }
}

/** Dismiss the hint everywhere, forever; notifies all mounted pills. */
export function dismissHint(): void {
  try {
    window.localStorage.setItem(TERMINAL_HINT_KEY, '1')
  } catch {
    sessionFallback = true // write failed — still hide for this session (in-memory)
  }
  subs.forEach((fn) => fn())
}

/** Test-only: clear the in-memory write-failure fallback (module state). */
export function resetHintSessionFallbackForTest(): void {
  sessionFallback = false
}

/** `useSyncExternalStore` subscribe contract. */
export function subscribeHint(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

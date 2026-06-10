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

/** True once the user has dismissed the hint anywhere (sticky, app-wide). */
export function isHintDismissed(): boolean {
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
    // Storage write failed → the pill still hides for this session via the emit below.
  }
  subs.forEach((fn) => fn())
}

/** `useSyncExternalStore` subscribe contract. */
export function subscribeHint(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

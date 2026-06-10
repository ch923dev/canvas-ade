/**
 * Pure auto-connect policy for Browser boards (no React, no IPC) — unit-testable.
 *
 * Reconnect + auto-push are one loop: a board that is NOT connected should keep
 * trying until it is. The policy never touches a `connected` board (so a working
 * preview, or a route the user navigated to, is never clobbered):
 *  - `load-failed` + has url      → `reload` (retry the same url; recovers when the
 *                                    dev server comes up at that url).
 *  - linked terminal + no url yet → `detect` (discover the dev-server url from the
 *                                    terminal's printed output, then push it).
 * An in-flight `connecting` load is left alone so a slow-but-legitimate load is
 * never interrupted; if it fails it becomes `load-failed` and the reload path takes over.
 */
export type PreviewStatusLike = 'idle' | 'connecting' | 'connected' | 'load-failed' | 'crashed'

export type AutoConnectPlan = { kind: 'idle' } | { kind: 'reload' } | { kind: 'detect' }

export interface AutoConnectInput {
  status: PreviewStatusLike
  /** board.url is a non-empty http(s) URL. */
  hasUrl: boolean
  /** board.previewSourceId is set (a linked source terminal). */
  hasSource: boolean
}

export function planAutoConnect(i: AutoConnectInput): AutoConnectPlan {
  if (i.status === 'connected') return { kind: 'idle' }
  // D2-C: a crashed renderer recovers ONLY via the explicit Reload CTA. A page that
  // crashes deterministically (OOM / GPU bug) would otherwise relaunch-crash forever
  // on the backoff ramp — never auto-loop a crash.
  if (i.status === 'crashed') return { kind: 'idle' }
  if (i.status === 'load-failed' && i.hasUrl) return { kind: 'reload' }
  if (i.hasSource && !i.hasUrl) return { kind: 'detect' }
  return { kind: 'idle' }
}

/**
 * Ticks to wait before the NEXT attempt, given how many attempts already fired
 * (base tick = 1s): 1st→1s, 2nd→2s, 3rd+→4s. Caps at 4 so polling never stalls.
 */
export function backoffTicks(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 4)
}

/** True when `u` parses as an http(s) URL — the Browser board's reconnect-eligible scheme. */
export function isHttpUrl(u: string): boolean {
  try {
    const x = new URL(u)
    return x.protocol === 'http:' || x.protocol === 'https:'
  } catch {
    return false
  }
}

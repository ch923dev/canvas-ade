/**
 * Test seam for the app-chrome overlays that live in components' LOCAL React state —
 * Settings, Sign-in, the recap-consent prompt (AppChrome) and the notification-bell panel.
 *
 * WHY THIS EXISTS. `__canvasE2E.reset()` is the documented per-test isolation seam: with
 * `workers:1` Playwright reuses ONE Electron app across every spec file, so anything a spec
 * leaves standing is inherited by the next one. `reset()` already closes the digest panel, the
 * group popovers, the library panel, toasts and the switch-transition overlay for exactly that
 * reason — but every one of those is reachable either through a zustand store or through
 * `E2EHostHooks`, which `CanvasInner` registers. `AppChrome` is a SIBLING of `CanvasInner`, and
 * its modal flags are plain `useState`, so neither route can reach them.
 *
 * The leak this was written for: `mcpServers.e2e.ts` opens Settings and never closes it. Its
 * scrim is a full-viewport, pointer-intercepting layer, so the next spec that issues a REAL OS
 * click — `menuShell.e2e.ts` — spent 30 s watching `<div data-test="settings-scrim">` swallow
 * every attempt. It read as a flake only because a failed test makes Playwright relaunch the
 * worker, so the retry always got a clean app.
 *
 * Deliberately a module singleton rather than a store: these flags are ephemeral chrome state
 * that the product has no reason to expose globally, and promoting them to a store purely to
 * satisfy a test seam would be the tail wagging the dog. Registration is e2e-gated, so a
 * production build registers nothing and `closeChromeOverlays()` is a no-op.
 *
 * MULTI-REGISTRANT CONTRACT (bell PR): the slot is a Set, not a single closer — AppChrome and
 * NotificationBell each register their own. A second registrant must never clobber the first
 * (the single-slot version would have silently reintroduced the settings-scrim leak above the
 * moment the bell mounted). `closeChromeOverlays()` runs a snapshot of every registered closer.
 */

/** Registered by chrome components under `isE2E()`; empty in production and before mount. */
const closers = new Set<() => void>()

/**
 * Register a chrome overlay-closer. Returns an unregister function for the effect cleanup —
 * Set semantics make it idempotent, and one component's cleanup can never drop another's closer.
 */
export function registerChromeOverlayCloser(fn: () => void): () => void {
  closers.add(fn)
  return () => {
    closers.delete(fn)
  }
}

/** Close every app-chrome overlay. No-op when nothing is registered (production, or pre-mount). */
export function closeChromeOverlays(): void {
  for (const fn of [...closers]) fn()
}

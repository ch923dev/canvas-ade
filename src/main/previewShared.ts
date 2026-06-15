import { shell } from 'electron'

/**
 * Shared Browser-preview helpers — the engine-agnostic core that BOTH the offscreen
 * (OSR) preview path and (historically) the native `WebContentsView` path build on.
 *
 * Extracted in OS-3 Phase 5C when the native engine was deleted: these pure predicates,
 * the page-driven navigation guards, the failed-load / crash-ready latches, and the
 * `PreviewEvent` wire type are still needed by `previewOsr.ts` (which registers the same
 * guards / latch / crash gate on its offscreen webContents and emits the SAME
 * `preview:event` channel) and `windowSecurity.ts` (`isAllowedExternal`). Everything here
 * is Electron-light (only `shell` for `openExternalSafe`) and unit-tested in
 * `previewShared.test.ts`.
 */

/**
 * Preview lifecycle event pushed main → renderer (Phase 2.2). The renderer keys it
 * by board `id` to drive the URL bar (live URL, connecting/connected/load-failed)
 * and the back/forward affordance. Kept structurally in sync with the preload's
 * `PreviewEvent` (preload re-declares it to avoid a main→preload type import).
 */
export type PreviewEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  // `recovered` (BUG-004): set only by an in-page nav that committed a non-error in-app
  // route AFTER a prior failure: lets the renderer lift a stale `load-failed`/`crashed`
  // latch back to `connected` (an in-page route fires no did-finish-load to promote it).
  | {
      id: string
      type: 'did-navigate'
      url: string
      canGoBack: boolean
      canGoForward: boolean
      recovered?: boolean
    }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }
  // A fresh main-frame navigation STARTED (reload / back / forward / in-page link).
  // Lets the renderer clear a stale `load-failed` latch so the following
  // did-finish-load can promote to `connected` (Bug #5).
  | { id: string; type: 'did-start-navigation' }
  // Esc pressed while the preview's web content owns focus. The renderer window
  // never sees this keydown, so forward it to let the renderer exit full view.
  | { id: string; type: 'escape' }
  // The preview's renderer process died (D2-C). The board freezes silently without
  // this — the renderer shows a "Preview crashed" state with a Reload CTA.
  | { id: string; type: 'render-process-gone'; reason: string }

/**
 * Secondary failure signal from `did-navigate`'s `httpResponseCode` (Bug #5). A
 * Chromium error page commits with code `0`; a real HTTP error page is `>= 400`.
 * `-1` means a non-HTTP navigation (e.g. `file:`/`about:`) and a 2xx/3xx is a normal
 * load — neither is treated as a failure. Pure so it can be unit-tested.
 */
export function isErrorResponseCode(code: number): boolean {
  return code === 0 || code >= 400
}

/**
 * An HTTP-server error RESPONSE (4xx/5xx) that committed a real (non-blank) error
 * page (Bug #7). Distinct from `isErrorResponseCode`: a Chromium-generated error
 * page commits with code `0` and is ALWAYS preceded by a real `did-fail-load`, so
 * re-emitting a failure for code `0` would be redundant. The 4xx/5xx case, by
 * contrast, fires NO `did-fail-load` (the server answered) — its `did-navigate`
 * carries the only failure signal, so it needs its own terminal `did-fail-load`
 * emit or the board is stranded on "connecting" forever. Pure / unit-testable.
 */
export function isHttpErrorCode(code: number): boolean {
  return code >= 400
}

/**
 * Schemes the preview's OWN webContents is allowed to load (Bug #32). A Browser
 * board previews a localhost dev server, never the local filesystem or arbitrary
 * protocols — `file:`/`data:`/`smb:`/custom schemes are rejected at this trust
 * boundary so the preview can never become a general browser / file viewer,
 * regardless of how `board.url` was set (typed, pasted, or imported in Phase 3).
 * Pure (parses with the WHATWG `URL`) so it is unit-testable.
 */
export function isAllowedPreviewUrl(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  return u.protocol === 'http:' || u.protocol === 'https:'
}

/**
 * Schemes we hand to the OS via `shell.openExternal` (Bug #23). Untrusted preview
 * content can call `window.open('file:///…')` / `smb://…` / a registered custom
 * protocol; without this gate that URL would be handed straight to the OS handler.
 * Restrict to web + mail; everything else is silently dropped. Pure / unit-testable.
 */
export function isAllowedExternal(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:'
}

/**
 * Open a URL in the OS browser ONLY if its scheme is allowlisted (Bug #23). Returns
 * whether it was actually opened (false = scheme blocked / unparseable) so callers can
 * surface feedback; the setWindowOpenHandler caller ignores the result.
 */
export function openExternalSafe(rawUrl: string): boolean {
  if (!isAllowedExternal(rawUrl)) return false
  void shell.openExternal(rawUrl)
  return true
}

/**
 * Per-view rate limiter for page-initiated external opens (BUG-029). Electron does
 * not enforce Chromium's user-activation requirement for window.open, so untrusted
 * preview content could `setInterval(() => window.open('https://attacker/'), 50)`
 * and flood the OS browser with real-chrome tabs (desktop DoS + phishing assist).
 * Policy: a token bucket per view — a burst of `capacity` (3) opens, refilling one
 * token per `refillMs` (10s). Generous for legitimate single link-clicks (one open
 * per click) while capping a scripted flood at ~6/min; excess opens are silently
 * dropped. The renderer-driven `preview:openExternal` (a real user gesture on app
 * chrome) is NOT limited. Pure factory (injectable clock) so it is unit-testable.
 */
export function createOpenExternalLimiter(
  capacity = 3,
  refillMs = 10_000,
  now: () => number = Date.now
): () => boolean {
  let tokens = capacity
  let last = now()
  return () => {
    const t = now()
    tokens = Math.min(capacity, tokens + (t - last) / refillMs)
    last = t
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

/** A cancellable navigation event (the `event` arg of will-navigate/will-redirect). */
interface CancellableNav {
  preventDefault(): void
}
/** The `details` arg of will-frame-navigate (covers subframes via `url`). */
interface FrameNavDetails extends CancellableNav {
  url: string
}
/** The webContents surface the preview nav guards listen on (minimal, testable). */
interface NavGuardTarget {
  on(event: 'will-navigate', listener: (ev: CancellableNav, url: string) => void): unknown
  on(event: 'will-redirect', listener: (ev: CancellableNav, url: string) => void): unknown
  on(event: 'will-frame-navigate', listener: (details: FrameNavDetails) => void): unknown
}

/**
 * Enforce the http(s)-only scheme allowlist (Bug #32) on EVERY page-driven navigation
 * of the preview's webContents: top-frame loads (`will-navigate`), 30x redirect legs
 * (`will-redirect`), and subframe navigations (`will-frame-navigate`) — `will-navigate`
 * alone misses the latter two (Bug #14). Mirrors the main-window guard (index.ts:89-95).
 * Renderer-issued loads are already gated at the IPC boundary, so the remaining surface
 * is page-driven cross-document navigation.
 * Extracted (and given a minimal target type) so it can be unit-tested with a fake wc.
 */
export function registerPreviewNavGuards(wc: NavGuardTarget): void {
  const guard = (ev: CancellableNav, url: string): void => {
    if (!isAllowedPreviewUrl(url)) ev.preventDefault()
  }
  wc.on('will-navigate', (ev, url) => guard(ev, url))
  wc.on('will-redirect', (ev, url) => guard(ev, url))
  wc.on('will-frame-navigate', (details) => guard(details, details.url))
}

/** A holder for the mutable `failed` latch (the live preview entry satisfies this). */
interface FailedLatch {
  failed: boolean
}
/** The minimal webContents surface the load latch listens on (testable). */
interface LoadLatchTarget {
  on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean }) => void): unknown
  on(event: 'did-finish-load', listener: () => void): unknown
  on(
    event: 'did-fail-load',
    listener: (
      ev: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => void
  ): unknown
}

/**
 * The `failed`-latch lifecycle (Bug #5), extracted so it can be unit-tested without
 * Electron (TEST T5). A dead/refused main-frame load fires `did-fail-load`, then
 * Chromium loads an error page whose `did-finish-load` must NOT promote the board back
 * to "connected" — the latch suppresses that spurious success. A fresh main-frame
 * `did-start-navigation` clears the latch so a successful reload/back/forward can
 * promote again. `onSuccess(getUrl())` is the connected emit; `onFail(...)` is the
 * load-failed emit; `onNavStart()` lets the renderer clear its own stale latch.
 *
 * Sub-resource / aborted main-frame failures (errorCode -3) and subframe loads are not
 * board-level failures and don't latch. `applyZoom` runs on every finish (even the
 * error page lays out) regardless of the latch.
 */
export function registerLoadLatch(
  wc: LoadLatchTarget,
  latch: FailedLatch,
  hooks: {
    getUrl: () => string
    applyZoom: () => void
    onNavStart: () => void
    onSuccess: (url: string) => void
    onFail: (errorCode: number, errorDescription: string, validatedURL: string) => void
  }
): void {
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame) return
    latch.failed = false
    hooks.onNavStart()
  })
  wc.on('did-finish-load', () => {
    hooks.applyZoom()
    if (!latch.failed) hooks.onSuccess(hooks.getUrl())
  })
  wc.on('did-fail-load', (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    latch.failed = true
    hooks.onFail(errorCode, errorDescription, validatedURL)
  })
}

/**
 * In-page (client-side route) recovery of a failed load (BUG-004). A `did-navigate`
 * carrying a `>= 400` HTTP code latches `failed` (and emits a terminal did-fail-load),
 * but the ONLY clear of that latch is registerLoadLatch's main-frame did-start-navigation:
 * an in-page route (did-navigate-in-page) re-emits did-navigate and NEVER clears it, so
 * after a 4xx document then a client-side route to a working in-app view the board stays
 * stuck on `load-failed`. An in-page nav commits real, non-error in-app content, so when the
 * latch is set we clear it symmetrically and report `true` so the caller can flag the
 * did-navigate `recovered` (the renderer then lifts load-failed back to connected; the
 * in-page nav fires no did-finish-load to promote it). When the latch is clear this is a
 * normal in-page nav and returns `false`. Pure (mutates only the passed latch) so it is
 * unit-testable without Electron, mirroring registerLoadLatch.
 */
export function clearLatchOnInPageRecovery(latch: FailedLatch): boolean {
  if (!latch.failed) return false
  latch.failed = false
  return true
}

/** A holder for the mutable `ready` flag (the live preview entry satisfies this). */
interface ReadyHolder {
  ready: boolean
}
/** The minimal webContents surface the crash/ready gate listens on (testable). */
interface CrashReadyTarget {
  on(event: 'did-finish-load', listener: () => void): unknown
  on(
    event: 'render-process-gone',
    listener: (ev: unknown, details: { reason: string }) => void
  ): unknown
}

/**
 * Snapshot-until-ready + crashed-renderer recovery (D2-C), extracted so it can be
 * unit-tested without Electron (mirrors `registerLoadLatch`). A freshly-created or
 * crash-relaunched preview renderer paints a BLANK WHITE frame until its first
 * `did-finish-load`; `holder.ready` gates the preview's visibility so the state
 * underneath carries the gap. `render-process-gone` clears `ready` (the renderer is
 * now dead and must not cover the "Preview crashed" state) and reports the crash
 * reason; a later reload's finish-load restores it. `onReady` re-shows the preview;
 * `onCrashed` hides it + emits the lifecycle event.
 *
 * `isFailed` reads the load latch (Bug #5): a FAILED load's finish-load is
 * Chromium's error page laying out, NOT real content — marking ready there would
 * re-show a blank error page over the board's load-failed state
 * (crash → reload → server-still-down). The latch-clearing nav-start + a real
 * successful finish-load restore `ready` as usual.
 */
export function registerCrashReadyGate(
  wc: CrashReadyTarget,
  holder: ReadyHolder,
  hooks: {
    onReady: () => void
    onCrashed: (reason: string) => void
    isFailed: () => boolean
  }
): void {
  wc.on('did-finish-load', () => {
    if (hooks.isFailed()) return
    holder.ready = true
    hooks.onReady()
  })
  wc.on('render-process-gone', (_ev, details) => {
    holder.ready = false
    hooks.onCrashed(details.reason)
  })
}

import type { IpcMain, BrowserWindow, Rectangle } from 'electron'
import { WebContentsView, shell } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Preview lifecycle event pushed main → renderer (Phase 2.2). The renderer keys it
 * by board `id` to drive the URL bar (live URL, connecting/connected/load-failed)
 * and the back/forward affordance. Kept structurally in sync with the preload's
 * `PreviewEvent` (preload re-declares it to avoid a main→preload type import).
 */
export type PreviewEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  | { id: string; type: 'did-navigate'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }
  // A fresh main-frame navigation STARTED (reload / back / forward / in-page link).
  // Lets the renderer clear a stale `load-failed` latch so the following
  // did-finish-load can promote to `connected` (Bug #5).
  | { id: string; type: 'did-start-navigation' }
  // Esc pressed while the native view's web content owns focus. The renderer window
  // never sees this keydown, so forward it to let the renderer exit full view.
  | { id: string; type: 'escape' }
  // The preview's renderer process died (D2-C). The board freezes silently without
  // this — the renderer shows a "Preview crashed" state with a Reload CTA.
  | { id: string; type: 'render-process-gone'; reason: string }

/**
 * PreviewManager (1-E): N native WebContentsViews keyed by board id, synced to the
 * canvas camera by the renderer. A native view paints ABOVE all HTML and cannot be
 * clipped/rounded, so motion / LOD is carried by HTML snapshots (capturePage); this
 * side just owns the views' lifecycle, bounds, zoom factor, and attachment.
 *
 * No `destroy()` exists on WebContentsView — every removed board MUST
 * `webContents.close()` or it leaks a renderer process. The renderer enforces the
 * "cap ~4 live" policy; this side is mechanism-only (attach / detach / close).
 */
interface Entry {
  view: WebContentsView
  attached: boolean
  /** Desired zoom factor; re-applied on every load (a reload resets zoom to 1). */
  zoom: number
  /**
   * The current main-frame load failed (dead/refused URL). Chromium loads an error
   * page AFTER `did-fail-load`, which fires its own `did-finish-load` — without this
   * latch we'd emit a spurious `did-finish-load` (renderer shows "connected") and
   * clobber the `load-failed` state. Reset on each main-frame navigation start.
   */
  failed: boolean
  /**
   * The webContents has composited real content at least once since (re)creation
   * (D2-C snapshot-until-ready). A freshly-opened or crash-relaunched renderer
   * paints a blank white frame until its first `did-finish-load`; while `ready` is
   * false, `attach()` keeps the native layer hidden so the HTML snapshot / state
   * underneath stays painted. Set by the first finish-load, cleared on
   * `render-process-gone`.
   */
  ready: boolean
}

const views = new Map<string, Entry>()
let owner: BrowserWindow | null = null

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
 * Schemes the preview's OWN native view is allowed to load (Bug #32). A Browser
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
function openExternalSafe(rawUrl: string): boolean {
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
 * of the preview's native view: top-frame loads (`will-navigate`), 30x redirect legs
 * (`will-redirect`), and subframe navigations (`will-frame-navigate`) — `will-navigate`
 * alone misses the latter two (Bug #14). Mirrors the main-window guard (index.ts:89-95).
 * Renderer-issued loads (`preview:open`/`preview:navigate`) are already gated at the
 * IPC boundary, so the remaining surface is page-driven cross-document navigation.
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

/** A holder for the mutable `failed` latch (the live `Entry` satisfies this). */
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

/** A holder for the mutable `ready` flag (the live `Entry` satisfies this). */
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
 * `did-finish-load`; `holder.ready` gates the native view's visibility in `attach()`
 * so the HTML snapshot/state underneath carries the gap. `render-process-gone`
 * clears `ready` (the view is now a dead layer that must not cover the renderer's
 * "Preview crashed" state) and reports the crash reason; a later reload's
 * finish-load restores it. `onReady` re-shows an attached view; `onCrashed` hides
 * the view + emits the lifecycle event.
 *
 * `isFailed` reads the load latch (Bug #5): a FAILED load's finish-load is
 * Chromium's error page laying out, NOT real content — marking ready there would
 * re-show the view as a blank error page over the board's load-failed state
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

function round(b: Rectangle): Rectangle {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
}

/**
 * Push a preview lifecycle event to the renderer (Phase 2.2). The Browser board's
 * URL/route bar reflects connecting / connected / load-failed and the live URL +
 * nav-affordance state from these. Sent on the owner window's main-world channel
 * (`preview:event`); the preload re-exposes a typed `onPreviewEvent` subscriber.
 */
function emit(ev: PreviewEvent): void {
  try {
    owner?.webContents.send('preview:event', ev)
  } catch {
    /* window gone */
  }
}

function ensure(id: string, win: BrowserWindow): Entry {
  owner = win
  let e = views.get(id)
  if (!e) {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Per-board in-memory session. Chromium stores page zoom per-host in the
        // SESSION's zoom map, so views sharing a session + origin would share zoom
        // (setZoomFactor on one rewrites it for all → presets sync). A unique
        // partition per board isolates zoom (and cache/cookies) per view.
        partition: `preview-${id}`
      }
    })
    e = { view, attached: false, zoom: 1, failed: false, ready: false }
    views.set(id, e)
    const wc = view.webContents
    // Deny-by-default permission policy on this view's session (Bug: no-permission-
    // handler-preview-views). The preview loads UNTRUSTED localhost content; without
    // a handler the page could request camera/mic/geolocation/notifications/etc. and
    // the user would see an OS-level prompt from what looks like the app itself.
    // Each view gets its own in-memory session (`partition: preview-<id>`), so this
    // fires once per freshly-created view and never re-sets an already-configured
    // session. Both the async request handler and the synchronous check handler are
    // set for defense-in-depth.
    const sess = wc.session
    sess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    sess.setPermissionCheckHandler(() => false)
    // External links open in the OS browser, never inside the preview (security:
    // the preview must never become a general web browser / nav target). The scheme
    // is allowlisted (Bug #23) so untrusted preview content can't smuggle a
    // file:/smb:/custom-protocol URL to the OS handler via window.open, and a
    // per-view token bucket (BUG-029: burst 3, +1 token/10s) caps gesture-free
    // window.open floods so a hostile page can't tab-bomb the user's OS browser.
    const allowExternalOpen = createOpenExternalLimiter()
    wc.setWindowOpenHandler(({ url }) => {
      if (allowExternalOpen()) openExternalSafe(url)
      return { action: 'deny' }
    })
    // Defense-in-depth (Bug #16/#32/#14): block a page-driven navigation to a
    // disallowed scheme (file:/data:/external) — top-frame, 30x redirect leg, and
    // subframes — so a previewed page can't turn the view into a general browser /
    // file viewer. The URL bar drives navigation via `preview:navigate` → loadURL
    // (already scheme-gated), not through these, so legitimate localhost nav is fine.
    registerPreviewNavGuards(wc)
    // Esc inside a focused native view: its web content consumes the keydown, so the
    // renderer's window-level Esc handler never fires and a full-view Browser board can't
    // be exited from the keyboard. Forward an `escape` event (only on keyDown so we don't
    // double-fire on the keyUp) so the renderer can close full view — matching the
    // Esc-exits-full-view behaviour terminals/notes get from the window handler. We don't
    // preventDefault: the page may also use Esc, and full view is gated renderer-side.
    // D4-B (audit A3): Esc is ALSO the focus-return gesture — a clicked preview otherwise
    // traps keyboard focus in the native view with no way back to app chrome. Hand OS
    // focus back to the host window's webContents here (only MAIN can move focus between
    // webContents); the renderer side (usePreviewEvents) selects the board so the
    // keyboard context lands visibly where the user was. The page still receives the Esc
    // key because we never call preventDefault on the before-input-event.
    wc.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        emit({ id, type: 'escape' })
        try {
          owner?.webContents.focus()
        } catch {
          /* window gone */
        }
      }
    })
    // The `failed`-latch lifecycle (Bug #5), wired via the extracted, unit-tested
    // `registerLoadLatch` (TEST T5):
    //  • did-start-navigation (main frame) clears the latch — until proven otherwise
    //    this load is assumed good — and tells the renderer to clear its own stale
    //    `load-failed` so the following did-finish-load can promote to `connected`
    //    after a successful reload/back/forward. Does NOT fire for Chromium's
    //    error-page commit (it reuses the failed navigation), so the error page's
    //    own did-finish-load suppression is preserved.
    //  • did-finish-load ALWAYS re-applies the held zoom factor (even the error page
    //    lays out, and a load resets the factor to 1) but only reports "connected"
    //    when the latch is clear — Chromium's error page fires its own did-finish-load
    //    AFTER did-fail-load, which would otherwise clobber the load-failed state.
    //  • did-fail-load latches `failed` for a real main-frame failure (ignoring the
    //    aborted/-3 case) so the error page's subsequent did-finish-load is suppressed.
    registerLoadLatch(wc, e, {
      getUrl: () => wc.getURL(),
      applyZoom: () => {
        try {
          wc.setZoomFactor(e!.zoom)
        } catch {
          /* view gone */
        }
      },
      onNavStart: () => emit({ id, type: 'did-start-navigation' }),
      onSuccess: (url) => emit({ id, type: 'did-finish-load', url }),
      onFail: (errorCode, errorDescription, validatedURL) =>
        emit({ id, type: 'did-fail-load', url: validatedURL, errorCode, errorDescription })
    })
    // Snapshot-until-ready + crash recovery (D2-C), via the extracted, unit-tested
    // `registerCrashReadyGate`:
    //  • the first did-finish-load after (re)creation marks the view `ready` and
    //    re-shows it if attached — until then attach() keeps the native layer hidden
    //    so the HTML snapshot/state underneath stays painted instead of a blank
    //    white renderer frame (the evicted-reattach 50–300ms blank, audit §3.4).
    //  • render-process-gone hides the (now dead) layer and pushes the crash to the
    //    renderer, which shows status `crashed` + a Reload CTA. A reload relaunches
    //    the renderer; its finish-load flows back through the ready path above.
    //  • isFailed reads the Bug #5 latch: a failed load's finish-load is Chromium's
    //    error page — it must NOT mark ready/re-show, or a crash-reload against a
    //    still-down server paints a blank error page over the load-failed state.
    registerCrashReadyGate(wc, e, {
      onReady: () => {
        const cur = views.get(id)
        if (cur?.attached) {
          try {
            cur.view.setVisible(true)
          } catch {
            /* view gone */
          }
        }
      },
      onCrashed: (reason) => {
        try {
          views.get(id)?.view.setVisible(false)
        } catch {
          /* view gone */
        }
        emit({ id, type: 'render-process-gone', reason })
      },
      isFailed: () => e!.failed
    })
    // Surface navigation so the renderer can update the URL bar + back/fwd state.
    // An error page navigates with httpResponseCode 0 (or ≥400 for HTTP errors) →
    // treat it as a failure latch even if did-fail-load didn't fire.
    wc.on('did-navigate', (_ev, url, httpResponseCode) => {
      if (isErrorResponseCode(httpResponseCode)) e!.failed = true
      // Bug #7: a 4xx/5xx server RESPONSE commits a real (non-blank) error page but
      // fires NO did-fail-load — so this did-navigate carries the only failure signal.
      // Without a terminal status the board stays "connecting" forever. Emit a
      // did-fail-load so the renderer resolves to "load-failed". Gated on ≥400 only:
      // code 0 (Chromium's own error page) already followed a real did-fail-load.
      if (isHttpErrorCode(httpResponseCode)) {
        emit({
          id,
          type: 'did-fail-load',
          url,
          errorCode: httpResponseCode,
          errorDescription: `HTTP ${httpResponseCode}`
        })
      }
      emit({
        id,
        type: 'did-navigate',
        url,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    })
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
      if (!isMainFrame) return
      emit({
        id,
        type: 'did-navigate',
        url,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    })
  }
  return e
}

function applyZoom(e: Entry, zoomFactor?: number): void {
  if (typeof zoomFactor !== 'number') return
  e.zoom = zoomFactor
  try {
    e.view.webContents.setZoomFactor(zoomFactor)
  } catch {
    /* not yet loaded; did-finish-load re-applies */
  }
}

function attach(e: Entry, bounds?: Rectangle, zoomFactor?: number): void {
  if (!owner) return
  if (!e.attached) {
    owner.contentView.addChildView(e.view)
    e.attached = true
  }
  // Re-show: detach hides the view (see below) to kill the frozen-frame ghost, so a
  // reattach must make it visible again — but ONLY once the webContents has real
  // content (D2-C snapshot-until-ready). A fresh/relaunched renderer is a blank
  // white layer until its first did-finish-load; keeping it hidden lets the HTML
  // snapshot underneath carry the gap (registerCrashReadyGate re-shows on ready).
  // NOTE: any attach() while `ready` is false (preview:attach mid crash-reload, the
  // per-frame setBoundsBatch positioning an attached-but-not-ready view) is
  // INTENTIONALLY a no-show — bounds keep tracking so the reveal lands in place,
  // but only the ready flip (or a ready re-attach) makes the layer visible.
  e.view.setVisible(e.ready)
  applyZoom(e, zoomFactor)
  if (bounds) e.view.setBounds(round(bounds))
}

function detach(e: Entry): void {
  if (!owner || !e.attached) return
  // BUG-005: the owner window may already be destroyed (window close / macOS
  // close->activate reopen) — touching its contentView would throw "Object has
  // been destroyed". The view left the window's tree with the window itself, so
  // only the flag needs clearing.
  if (owner.isDestroyed()) {
    e.attached = false
    return
  }
  // Hide the native layer BEFORE removing it from the view tree. `removeChildView`
  // alone (even with the #44652 fix present in Electron ≥33.2.1) can leave a stale
  // composited frame painted on screen across the rapid detach→reattach toggle a node
  // drag performs — a persistent "ghost" copy of the page stuck at an old position
  // (Electron #43961, still open). `setVisible(false)` stops the compositor painting it.
  e.view.setVisible(false)
  owner.contentView.removeChildView(e.view)
  e.attached = false
}

function disposeOne(id: string): void {
  const e = views.get(id)
  if (!e) return
  // BUG-005: detach and close live in SEPARATE try blocks — a detach throw must
  // never skip the mandatory close() below (WebContentsView has no destroy();
  // skipping close leaks the preview renderer while the entry leaves the map).
  try {
    detach(e)
  } catch {
    /* window/view gone */
  }
  try {
    e.view.webContents.close() // no destroy() — close or leak the renderer
  } catch {
    /* already gone */
  }
  views.delete(id)
}

interface OpenArgs {
  id: string
  url?: string
  bounds: Rectangle
  zoomFactor?: number
}
interface BoundsItem {
  id: string
  bounds: Rectangle
  zoomFactor?: number
}
interface AttachArgs {
  id: string
  bounds: Rectangle
  zoomFactor?: number
}

/**
 * Bug #33 (defense-in-depth): every handler below rejects IPC that did not originate from the
 * main window's main frame via the shared `isForeignSender` (./ipcGuard). ipcMain channels are
 * shared by ALL webContents, including the per-board preview WebContentsViews that load untrusted
 * localhost content; today those views have no preload (no ipcRenderer), so this is not
 * exploitable — but the guard ENFORCES the preview-isolation invariant rather than leaving it
 * incidental to the absence of a preview preload.
 */

export function registerPreviewHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  defaultUrl: string
): void {
  ipcMain.handle('preview:open', (ev, args: OpenArgs) => {
    if (isForeignSender(ev, getWin)) throw new Error('preview:open — forbidden sender')
    const win = getWin()
    if (!win) throw new Error('preview:open — no window')
    const e = ensure(args.id, win)
    attach(e, args.bounds, args.zoomFactor)
    const url = args.url || defaultUrl
    // Scheme allowlist at the trust boundary (Bug #32): only http(s) loads, so a
    // file:/data:/external-protocol URL can never be fetched into the native view.
    // A rejected URL emits a terminal failure so the board shows "Couldn't load".
    if (isAllowedPreviewUrl(url)) {
      void e.view.webContents.loadURL(url)
    } else {
      e.failed = true
      emit({
        id: args.id,
        type: 'did-fail-load',
        url,
        errorCode: -1,
        errorDescription: 'blocked scheme'
      })
    }
    return { url }
  })

  // One coalesced batch for ALL views per frame (the channel is shared with
  // node-pty, so we never fan out one IPC per view per frame).
  ipcMain.handle('preview:setBoundsBatch', (ev, items: BoundsItem[]) => {
    if (isForeignSender(ev, getWin)) return true
    for (const it of items) {
      const e = views.get(it.id)
      if (!e || !e.attached) continue
      applyZoom(e, it.zoomFactor)
      e.view.setBounds(round(it.bounds))
    }
    return true
  })

  // Capture the CURRENT on-screen pixels as a data URL. Must run while attached —
  // a detached/off-screen view captures blank.
  ipcMain.handle('preview:capture', async (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return null
    const e = views.get(id)
    if (!e || !e.attached) return null
    try {
      const img = await e.view.webContents.capturePage()
      return img.isEmpty() ? null : img.toDataURL()
    } catch {
      // No composited display surface (headless / GPU-contended host, e.g. several
      // Electron instances at once) or the view was closed mid-capture: capturePage
      // rejects. Return null (treated as "no snapshot") rather than letting the
      // rejection propagate to the renderer await and skip its detach (Bug #9).
      return null
    }
  })

  ipcMain.handle('preview:detach', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return true
    const e = views.get(id)
    if (e) detach(e)
    return true
  })

  ipcMain.handle('preview:detachAll', (ev) => {
    if (isForeignSender(ev, getWin)) return true
    for (const e of views.values()) detach(e)
    return true
  })

  ipcMain.handle('preview:attach', (ev, args: AttachArgs) => {
    if (isForeignSender(ev, getWin)) return true
    const e = views.get(args.id)
    if (e) attach(e, args.bounds, args.zoomFactor)
    return true
  })

  ipcMain.handle('preview:close', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return true
    disposeOne(id)
    return true
  })

  ipcMain.handle('preview:closeAll', (e) => {
    if (isForeignSender(e, getWin)) return true
    disposeAll()
    return true
  })

  // ── Navigation (Phase 2.2 browser) — additive control plane for the URL bar ──
  // Browser-board content is never trusted to drive the PTY; these only steer the
  // view's own webContents. `navigate` loads the user-edited URL (a reload resets
  // zoom → did-finish-load re-applies the held factor).
  ipcMain.handle('preview:navigate', (ev, args: { id: string; url: string }) => {
    if (isForeignSender(ev, getWin)) return false
    const e = views.get(args.id)
    if (!e) return false
    // Scheme allowlist (Bug #32) — same trust boundary as preview:open. A blocked
    // scheme is not loaded; the board is told it failed so it doesn't hang.
    if (!isAllowedPreviewUrl(args.url)) {
      e.failed = true
      emit({
        id: args.id,
        type: 'did-fail-load',
        url: args.url,
        errorCode: -1,
        errorDescription: 'blocked scheme'
      })
      return false
    }
    void e.view.webContents.loadURL(args.url)
    return true
  })

  ipcMain.handle('preview:goBack', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = views.get(id)
    if (e?.view.webContents.navigationHistory.canGoBack()) {
      e.view.webContents.navigationHistory.goBack()
      return true
    }
    return false
  })

  ipcMain.handle('preview:goForward', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = views.get(id)
    if (e?.view.webContents.navigationHistory.canGoForward()) {
      e.view.webContents.navigationHistory.goForward()
      return true
    }
    return false
  })

  ipcMain.handle('preview:reload', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = views.get(id)
    if (!e) return false
    e.view.webContents.reload()
    return true
  })

  // Open the preview's current URL in the OS browser (for real DevTools / extensions).
  // Scheme stays allowlisted via openExternalSafe (Bug #23) — the renderer passes the
  // URL it already shows (liveUrl ?? board.url); nothing new can reach the OS handler
  // that window.open couldn't already. Frame-guarded (Bug #33).
  ipcMain.handle('preview:openExternal', (ev, url: string) => {
    if (isForeignSender(ev, getWin)) return false
    // Returns whether the URL was actually opened — false when the scheme is blocked
    // (openExternalSafe allowlist, Bug #23) so the renderer can surface feedback.
    return openExternalSafe(String(url))
  })
}

/** Close every view (app shutdown / leak-check). */
export function disposeAll(): void {
  for (const id of [...views.keys()]) disposeOne(id)
  owner = null
}

/**
 * E2E (in-process smoke) ONLY — read-only accessors over the live `views` Map.
 * `capturePage()` is BLANK for a detached/off-screen view, so this returns
 * `attached` too: the harness must ensure the board is live (zoom ≥ LOD, on-screen,
 * connected) before trusting `empty`. Not a security change — it exposes nothing the
 * preview IPC handlers don't already.
 */
export async function debugCaptureView(id: string): Promise<{ attached: boolean; empty: boolean }> {
  const e = views.get(id)
  if (!e || !e.attached) return { attached: false, empty: true }
  try {
    const img = await e.view.webContents.capturePage()
    return { attached: true, empty: img.isEmpty() }
  } catch {
    // No composited display surface (headless / GPU-contended host, e.g. several
    // Electron instances at once): capturePage rejects. Report empty rather than
    // letting the rejection abort the whole e2e run before any marker prints — the
    // browser part then fails gracefully while the other board asserts still report.
    return { attached: true, empty: true }
  }
}

/**
 * Capture a board's live native view as PNG bytes, or null if the view is missing /
 * detached / off-screen / blank / un-composited. `capturePage()` is BLANK for a
 * detached or off-screen view, so the caller must ensure the board is live first.
 * Used by the user-facing screenshot IPC (previewScreenshot.ts) and the e2e helper.
 */
export async function captureViewPng(id: string): Promise<Buffer | null> {
  const e = views.get(id)
  if (!e || !e.attached) return null
  try {
    const img = await e.view.webContents.capturePage()
    return img.isEmpty() ? null : img.toPNG()
  } catch {
    return null
  }
}

/**
 * E2E ONLY — capture the live on-screen pixels of a board's view as PNG bytes, or null
 * if the view is missing / detached / off-screen / blank / un-composited. A native
 * WebContentsView paints ABOVE all HTML, so Playwright's `page.screenshot()` is blank
 * where the browser board is — this is the ONLY path to visual evidence of native-view
 * content. Same `capturePage()` constraint as `debugCaptureView`: must be attached + on
 * screen or the capture is blank. The caller (e2eMain `captureViewToFile`) owns disk I/O.
 */
export async function debugCaptureViewPng(id: string): Promise<Buffer | null> {
  return captureViewPng(id)
}

/** E2E ONLY — ids of every native preview view currently created. */
export function debugViewIds(): string[] {
  return [...views.keys()]
}

/**
 * E2E ONLY — forcefully crash a board's preview renderer process (the D2-C
 * crashed-state probe). Drives the REAL `render-process-gone` path: hide the dead
 * layer, emit the lifecycle event, renderer shows the Reload CTA. Returns false when
 * no view exists. Read-only over the Map + an OS process kill of the app's own child;
 * exposes nothing a misbehaving previewed page couldn't already do to itself.
 *
 * Kill mechanism: SIGKILL the renderer's OS process instead of Chromium's
 * `forcefullyCrashRenderer()`. The Chromium call is a SILENT NO-OP under some
 * containerized kernels (found 2026-06-13: after a Docker Desktop/WSL2 update the
 * Linux-Docker e2e leg's renderer survived it — no `render-process-gone`, no error,
 * probe-proven) while the OS kill fires `render-process-gone` (`reason: 'killed'`)
 * identically on every platform — Node maps SIGKILL to TerminateProcess on Windows.
 * The renderer maps ANY `render-process-gone` to status `crashed`
 * (usePreviewEvents.ts), so the observable app path is unchanged. Falls back to
 * `forcefullyCrashRenderer()` when the pid is unavailable (renderer not started).
 */
export function debugCrashView(id: string): boolean {
  const e = views.get(id)
  if (!e) return false
  try {
    const pid = e.view.webContents.getOSProcessId()
    if (pid > 0) {
      process.kill(pid, 'SIGKILL')
    } else {
      e.view.webContents.forcefullyCrashRenderer()
    }
    return true
  } catch {
    return false
  }
}

/**
 * E2E ONLY — the live webContents id for a board's view, or null if none exists. A
 * close + reopen (`disposeOne` → `openPreview`) mints a NEW webContents (new id); a
 * detach + reattach keeps the SAME one. Lets a probe assert page-state survival across
 * a full-view toggle deterministically (no reliance on a status blip's timing), mirroring
 * the terminal pid-survival assertion.
 */
export function debugViewWebContentsId(id: string): number | null {
  const e = views.get(id)
  if (!e) return null
  try {
    return e.view.webContents.id
  } catch {
    return null
  }
}

/**
 * E2E ONLY — the native view's CURRENT bounds (the rect last applied via `setBounds`,
 * i.e. where the OS compositor paints it) plus whether it is attached. Lets an alignment
 * probe compare the native rect to the HTML `.bb-frame` `getBoundingClientRect` and prove
 * the native layer stays congruent with its frame at rest / after pan / zoom / resize.
 * Exposes nothing the preview IPC handlers don't already (read-only over the live Map).
 */
export function debugViewBounds(id: string): { attached: boolean; bounds: Rectangle } | null {
  const e = views.get(id)
  if (!e) return null
  try {
    return { attached: e.attached, bounds: e.view.getBounds() }
  } catch {
    return null
  }
}

/**
 * E2E ONLY — give a board's native view OS keyboard focus (the state a user reaches by
 * clicking inside the preview). The D4-B/A3 focus-return probe arms this, then drives a
 * real Esc through the view (debugSendInputToView) and asserts focus came back to the
 * host. Returns false when no view exists.
 */
export function debugFocusView(id: string): boolean {
  const e = views.get(id)
  if (!e) return false
  try {
    e.view.webContents.focus()
    return true
  } catch {
    return false
  }
}

/**
 * E2E ONLY — real OS input through a board's native view's webContents (the
 * `sendInput` sibling for preview views). The A3 probe sends Esc HERE — to the view,
 * not the host window — so the before-input-event forward + focus-return run the
 * exact production path.
 */
export function debugSendInputToView(
  id: string,
  evt: Parameters<Electron.WebContents['sendInputEvent']>[0]
): boolean {
  const e = views.get(id)
  if (!e) return false
  try {
    e.view.webContents.sendInputEvent(evt)
    return true
  } catch {
    return false
  }
}

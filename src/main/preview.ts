import type { IpcMain, BrowserWindow, Rectangle, IpcMainInvokeEvent } from 'electron'
import { WebContentsView, shell } from 'electron'

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

/** Open a URL in the OS browser ONLY if its scheme is allowlisted (Bug #23). */
function openExternalSafe(rawUrl: string): void {
  if (isAllowedExternal(rawUrl)) void shell.openExternal(rawUrl)
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
    e = { view, attached: false, zoom: 1, failed: false }
    views.set(id, e)
    const wc = view.webContents
    // External links open in the OS browser, never inside the preview (security:
    // the preview must never become a general web browser / nav target). The scheme
    // is allowlisted (Bug #23) so untrusted preview content can't smuggle a
    // file:/smb:/custom-protocol URL to the OS handler via window.open.
    wc.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url)
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
    wc.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') emit({ id, type: 'escape' })
    })
    // A fresh main-frame navigation clears the failed latch — until proven otherwise
    // (a later did-fail-load), this load is assumed good. Tell the renderer too so a
    // stale `load-failed` latch is cleared and the following did-finish-load can
    // promote to `connected` after a successful reload/back/forward (Bug #5). This
    // does NOT fire for Chromium's error-page commit (it reuses the failed
    // navigation, no new did-start-navigation), so the error page's own
    // did-finish-load suppression is preserved.
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      e!.failed = false
      emit({ id, type: 'did-start-navigation' })
    })
    // Re-apply the held zoom factor after each load so the page keeps laying out at
    // its fixed CSS width W (otherwise a load resets the factor to 1). ALWAYS re-apply
    // zoom (even the error page lays out), but only report "connected" when the load
    // didn't fail — Chromium's error page fires its own did-finish-load AFTER
    // did-fail-load, which would otherwise clobber the load-failed state (Bug #5).
    wc.on('did-finish-load', () => {
      try {
        wc.setZoomFactor(e!.zoom)
      } catch {
        /* view gone */
      }
      if (!e!.failed) emit({ id, type: 'did-finish-load', url: wc.getURL() })
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
    // Only the top-level (main-frame) load failure is a board-level "load-failed"
    // state; sub-resource/aborted loads (errorCode -3) are ignored. Latch `failed`
    // AFTER that guard so the error page's subsequent did-finish-load is suppressed.
    wc.on('did-fail-load', (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      e!.failed = true
      emit({ id, type: 'did-fail-load', url: validatedURL, errorCode, errorDescription })
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
  // reattach must make it visible again.
  e.view.setVisible(true)
  applyZoom(e, zoomFactor)
  if (bounds) e.view.setBounds(round(bounds))
}

function detach(e: Entry): void {
  if (!owner || !e.attached) return
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
  try {
    detach(e)
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
 * Bug #33 (defense-in-depth): reject IPC that did not originate from the main
 * window's main frame. ipcMain channels are shared by ALL webContents, including the
 * per-board preview WebContentsViews that load untrusted localhost content. Today
 * those views have no preload (no ipcRenderer), so this is not exploitable — but the
 * allowlist ENFORCES the preview-isolation invariant rather than leaving it incidental
 * to the absence of a preview preload. A synthetic/internal call (no senderFrame) is
 * allowed; only a real foreign frame is blocked.
 */
function isForeignSender(e: IpcMainInvokeEvent, getWin: () => BrowserWindow | null): boolean {
  const main = getWin()?.webContents.mainFrame
  return !!main && !!e.senderFrame && e.senderFrame !== main
}

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

/** E2E ONLY — ids of every native preview view currently created. */
export function debugViewIds(): string[] {
  return [...views.keys()]
}

import type { IpcMain, BrowserWindow, Rectangle } from 'electron'
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
    // the preview must never become a general web browser / nav target).
    wc.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    // A fresh main-frame navigation clears the failed latch — until proven otherwise
    // (a later did-fail-load), this load is assumed good.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame) e!.failed = false
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
  applyZoom(e, zoomFactor)
  if (bounds) e.view.setBounds(round(bounds))
}

function detach(e: Entry): void {
  if (!owner || !e.attached) return
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

export function registerPreviewHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  defaultUrl: string
): void {
  ipcMain.handle('preview:open', (_e, args: OpenArgs) => {
    const win = getWin()
    if (!win) throw new Error('preview:open — no window')
    const e = ensure(args.id, win)
    attach(e, args.bounds, args.zoomFactor)
    void e.view.webContents.loadURL(args.url || defaultUrl)
    return { url: args.url || defaultUrl }
  })

  // One coalesced batch for ALL views per frame (the channel is shared with
  // node-pty, so we never fan out one IPC per view per frame).
  ipcMain.handle('preview:setBoundsBatch', (_e, items: BoundsItem[]) => {
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
  ipcMain.handle('preview:capture', async (_e, id: string) => {
    const e = views.get(id)
    if (!e || !e.attached) return null
    const img = await e.view.webContents.capturePage()
    return img.isEmpty() ? null : img.toDataURL()
  })

  ipcMain.handle('preview:detach', (_e, id: string) => {
    const e = views.get(id)
    if (e) detach(e)
    return true
  })

  ipcMain.handle('preview:attach', (_e, args: AttachArgs) => {
    const e = views.get(args.id)
    if (e) attach(e, args.bounds, args.zoomFactor)
    return true
  })

  ipcMain.handle('preview:close', (_e, id: string) => {
    disposeOne(id)
    return true
  })

  ipcMain.handle('preview:closeAll', () => {
    disposeAll()
    return true
  })

  // ── Navigation (Phase 2.2 browser) — additive control plane for the URL bar ──
  // Browser-board content is never trusted to drive the PTY; these only steer the
  // view's own webContents. `navigate` loads the user-edited URL (a reload resets
  // zoom → did-finish-load re-applies the held factor).
  ipcMain.handle('preview:navigate', (_e, args: { id: string; url: string }) => {
    const e = views.get(args.id)
    if (!e) return false
    void e.view.webContents.loadURL(args.url)
    return true
  })

  ipcMain.handle('preview:goBack', (_e, id: string) => {
    const e = views.get(id)
    if (e?.view.webContents.navigationHistory.canGoBack()) {
      e.view.webContents.navigationHistory.goBack()
      return true
    }
    return false
  })

  ipcMain.handle('preview:goForward', (_e, id: string) => {
    const e = views.get(id)
    if (e?.view.webContents.navigationHistory.canGoForward()) {
      e.view.webContents.navigationHistory.goForward()
      return true
    }
    return false
  })

  ipcMain.handle('preview:reload', (_e, id: string) => {
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
  const img = await e.view.webContents.capturePage()
  return { attached: true, empty: img.isEmpty() }
}

/** E2E ONLY — ids of every native preview view currently created. */
export function debugViewIds(): string[] {
  return [...views.keys()]
}

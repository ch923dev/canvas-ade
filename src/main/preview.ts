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
}

const views = new Map<string, Entry>()
let owner: BrowserWindow | null = null

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
    e = { view, attached: false, zoom: 1 }
    views.set(id, e)
    const wc = view.webContents
    // External links open in the OS browser, never inside the preview (security:
    // the preview must never become a general web browser / nav target).
    wc.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    // Re-apply the held zoom factor after each load so the page keeps laying out at
    // its fixed CSS width W (otherwise a load resets the factor to 1).
    wc.on('did-finish-load', () => {
      try {
        wc.setZoomFactor(e!.zoom)
      } catch {
        /* view gone */
      }
      emit({ id, type: 'did-finish-load', url: wc.getURL() })
    })
    // Surface navigation so the renderer can update the URL bar + back/fwd state.
    wc.on('did-navigate', (_ev, url) => {
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
    // state; sub-resource/aborted loads (errorCode -3) are ignored.
    wc.on('did-fail-load', (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
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

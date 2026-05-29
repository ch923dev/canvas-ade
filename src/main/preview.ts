import type { IpcMain, BrowserWindow, Rectangle } from 'electron'
import { WebContentsView } from 'electron'

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
    // Re-apply the held zoom factor after each load so the page keeps laying out at
    // its fixed CSS width W (otherwise a load resets the factor to 1).
    view.webContents.on('did-finish-load', () => {
      try {
        view.webContents.setZoomFactor(e!.zoom)
      } catch {
        /* view gone */
      }
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
}

/** Close every view (app shutdown / leak-check). */
export function disposeAll(): void {
  for (const id of [...views.keys()]) disposeOne(id)
  owner = null
}

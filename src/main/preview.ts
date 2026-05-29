import type { IpcMain, BrowserWindow, Rectangle } from 'electron'
import { WebContentsView } from 'electron'

/**
 * Phase 0: a single WebContentsView proving native-overlay basics. Phase 1
 * turns this into a PreviewManager over N views, synced to the canvas camera.
 * A native view paints ABOVE all HTML and cannot be clipped/rounded — 1-D adds
 * detach + capturePage snapshotting so motion / LOD is carried by an HTML image
 * (which CAN be clipped/scaled) instead of the native layer.
 */
let view: WebContentsView | null = null
let owner: BrowserWindow | null = null
// Whether `view` is currently a child of the window's contentView. capturePage
// only works while attached + on-screen, so detach/attach are tracked explicitly
// (addChildView twice / removeChildView when absent both misbehave).
let attached = false

function round(b: Rectangle): Rectangle {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
}

function attach(bounds?: Rectangle): void {
  if (!view || !owner) return
  if (!attached) {
    owner.contentView.addChildView(view)
    attached = true
  }
  if (bounds) view.setBounds(round(bounds))
}

function detach(): void {
  if (!view || !owner || !attached) return
  owner.contentView.removeChildView(view)
  attached = false
}

export function registerPreviewHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  defaultUrl: string
): void {
  ipcMain.handle('preview:open', (_e, args: { url?: string; bounds: Rectangle }) => {
    const win = getWin()
    if (!win) throw new Error('preview:open — no window')
    owner = win
    if (!view) {
      view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
    }
    attach(args.bounds)
    void view.webContents.loadURL(args.url || defaultUrl)
    return { url: args.url || defaultUrl }
  })

  ipcMain.handle('preview:setBounds', (_e, bounds: Rectangle) => {
    if (view && attached) view.setBounds(round(bounds))
    return true
  })

  // Capture the CURRENT on-screen pixels as a data URL. Must run while attached —
  // a detached/off-screen view captures blank. The renderer captures, awaits, THEN
  // detaches (so the snapshot it shows during motion is never empty).
  ipcMain.handle('preview:capture', async () => {
    if (!view || !attached) return null
    const img = await view.webContents.capturePage()
    return img.isEmpty() ? null : img.toDataURL()
  })

  // Pull the native view out of the layer tree WITHOUT closing its renderer, so an
  // HTML snapshot can carry motion / LOD. `preview:attach` puts it back at bounds.
  ipcMain.handle('preview:detach', () => {
    detach()
    return true
  })

  ipcMain.handle('preview:attach', (_e, bounds: Rectangle) => {
    attach(bounds)
    return true
  })

  ipcMain.handle('preview:close', () => {
    disposePreview()
    return true
  })
}

export function disposePreview(): void {
  if (!view) return
  try {
    detach()
    // WebContentsView has no destroy(); close the renderer or leak it.
    view.webContents.close()
  } catch {
    /* already gone */
  }
  view = null
  owner = null
  attached = false
}

import type { IpcMain, BrowserWindow, Rectangle } from 'electron'
import { WebContentsView } from 'electron'

/**
 * Phase 0: a single WebContentsView proving native-overlay basics. Phase 1
 * turns this into a PreviewManager over N views, synced to the canvas camera.
 * A native view paints ABOVE all HTML and cannot be clipped/rounded — Phase 1
 * adds detach + capturePage snapshotting for LOD / occlusion.
 */
let view: WebContentsView | null = null
let owner: BrowserWindow | null = null

function round(b: Rectangle): Rectangle {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
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
      win.contentView.addChildView(view)
    }
    view.setBounds(round(args.bounds))
    void view.webContents.loadURL(args.url || defaultUrl)
    return { url: args.url || defaultUrl }
  })

  ipcMain.handle('preview:setBounds', (_e, bounds: Rectangle) => {
    view?.setBounds(round(bounds))
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
    owner?.contentView.removeChildView(view)
    // WebContentsView has no destroy(); close the renderer or leak it.
    view.webContents.close()
  } catch {
    /* already gone */
  }
  view = null
  owner = null
}

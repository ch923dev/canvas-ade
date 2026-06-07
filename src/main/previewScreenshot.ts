/**
 * Frame-guarded "screenshot the live preview" IPC. Captures a Browser board's native
 * WebContentsView, copies the PNG to the OS clipboard, and (when a project is open)
 * saves it into the project's content-addressed `assets/` store. Deps are injected so
 * the handler is unit-testable without Electron (mirrors clipboardIpc.ts).
 *
 * Security: frame-guarded (isForeignSender); writes only inside the open project dir
 * (writeAsset); never touches the PTY. A detached/off-screen view captures blank, so
 * that case returns { ok:false, reason:'not-live' } and the renderer guides the user.
 */
import { clipboard, nativeImage, type IpcMain, type BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { getCurrentDir, writeAsset } from './projectStore'
import { captureViewPng } from './preview'

export interface ScreenshotDeps {
  /** PNG bytes of the live view, or null if missing/detached/off-screen/blank. */
  capture(id: string): Promise<Buffer | null>
  writeImage(png: Buffer): void
  currentDir(): string | null
  saveAsset(dir: string, bytes: Uint8Array, ext: string): Promise<{ assetId: string }>
}

export type ScreenshotResult =
  | { ok: true; assetId: string | null }
  | { ok: false; reason: 'not-live' | 'forbidden' }

function realDeps(): ScreenshotDeps {
  return {
    capture: (id) => captureViewPng(id),
    writeImage: (png) => clipboard.writeImage(nativeImage.createFromBuffer(png)),
    currentDir: () => getCurrentDir(),
    saveAsset: (dir, bytes, ext) => writeAsset(dir, bytes, ext)
  }
}

export function registerPreviewScreenshotHandler(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ScreenshotDeps = realDeps()
): void {
  ipc.handle('preview:screenshot', async (e, id: string): Promise<ScreenshotResult> => {
    if (isForeignSender(e, getWin)) return { ok: false, reason: 'forbidden' }
    const png = await deps.capture(String(id))
    if (!png) return { ok: false, reason: 'not-live' }
    deps.writeImage(png)
    const dir = deps.currentDir()
    if (!dir) return { ok: true, assetId: null }
    try {
      const { assetId } = await deps.saveAsset(dir, png, 'png')
      return { ok: true, assetId }
    } catch {
      // Disk full / locked / read-only: the clipboard copy already succeeded, so report
      // success with no path rather than failing the whole action.
      return { ok: true, assetId: null }
    }
  })
}

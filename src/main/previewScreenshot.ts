/**
 * Frame-guarded "screenshot the live preview" IPC. Captures a Browser board's live preview,
 * copies the PNG to the OS clipboard, and (when a project is open) saves it into the project's
 * content-addressed `assets/` store. Deps are injected so the handler is unit-testable without
 * Electron (mirrors clipboardIpc.ts).
 *
 * Capture (OS-3 Phase 5C — OSR-only): the Browser preview renders in a hidden offscreen
 * window; `captureOsrPng` grabs its last painted frame. (The native `WebContentsView`
 * engine was deleted in 5C, so there is no native capture path left.)
 *
 * Security: frame-guarded (isForeignSender); writes only inside the open project dir
 * (writeAsset); never touches the PTY. An off-screen/blank/missing capture returns
 * { ok:false, reason:'not-live' } and the renderer guides the user.
 */
import { clipboard, nativeImage, type IpcMain, type BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { getCurrentDir, writeAsset } from './projectStore'
import { captureOsrPng } from './previewOsrCapture'

export interface ScreenshotDeps {
  /** PNG bytes of the live view, or null if missing/detached/off-screen/blank. */
  capture(id: string): Promise<Buffer | null>
  writeImage(png: Buffer): void
  currentDir(): string | null
  saveAsset(dir: string, bytes: Uint8Array, ext: string): Promise<{ assetId: string }>
}

export type ScreenshotResult =
  // BUG-028: `clipboardOk` reports whether the clipboard write actually landed —
  // previously a thrown writeImage was swallowed and `{ ok:true, assetId:null }`
  // read as "copied to clipboard" even when nothing was saved anywhere.
  | { ok: true; assetId: string | null; clipboardOk: boolean }
  | { ok: false; reason: 'not-live' | 'forbidden' }

function realDeps(): ScreenshotDeps {
  return {
    // The Browser preview is an offscreen window; capture its last painted frame.
    capture: async (id) => await captureOsrPng(id),
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
    let clipboardOk = true
    try {
      deps.writeImage(png)
    } catch {
      // Clipboard unavailable (headless / Wayland / locked session): non-fatal, still try
      // to save — but report it honestly (BUG-028).
      clipboardOk = false
    }
    const dir = deps.currentDir()
    if (!dir) return { ok: true, assetId: null, clipboardOk }
    try {
      const { assetId } = await deps.saveAsset(dir, png, 'png')
      return { ok: true, assetId, clipboardOk }
    } catch (err) {
      // Disk full / locked / read-only: report success with no path rather than failing the
      // whole action (the clipboard copy may still have landed — `clipboardOk` says).
      // Log so it's diagnosable.
      console.warn('[preview:screenshot] asset save failed:', err)
      return { ok: true, assetId: null, clipboardOk }
    }
  })
}

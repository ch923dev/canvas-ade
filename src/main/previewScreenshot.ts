/**
 * Frame-guarded "screenshot the live preview" IPC. Captures a Browser board's live preview,
 * copies the PNG to the OS clipboard, and (when a project is open) saves it as a timestamped
 * file in the project's `.canvas/downloads/` — the Browser boards' output folder, listed by the
 * Project Library's Downloads tab. Deps are injected so the handler is unit-testable without
 * Electron (mirrors clipboardIpc.ts).
 *
 * NOT the `assets/` store, on purpose: that store is content-addressed and owned by the
 * open-time mark-and-sweep (`gcAssets` in projectStore) — every blob in it must be referenced
 * by a persisted document or it is quarantined to `assets/.trash/` on the next project open.
 * A screenshot is referenced by nothing (it is an output file, not canvas content), so saving
 * it there made it vanish from the Library after one quit + relaunch.
 *
 * Capture (OS-3 Phase 5C — OSR-only): the Browser preview renders in a hidden offscreen
 * window; `captureOsrPng` grabs its last painted frame. (The native `WebContentsView`
 * engine was deleted in 5C, so there is no native capture path left.)
 *
 * Security: frame-guarded (isForeignSender); writes only inside the open project's
 * `.canvas/downloads/`, under a MAIN-composed filename (no renderer- or page-supplied string
 * reaches the path); never touches the PTY. An off-screen/blank/missing capture returns
 * { ok:false, reason:'not-live' } and the renderer guides the user.
 */
import { clipboard, nativeImage, type IpcMain, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { isForeignSender } from './ipcGuard'
import { downloadsDirOf, getCurrentDir } from './projectStore'
import { captureOsrPng } from './previewOsrCapture'
import { uniqueSavePath } from './previewOsrWidgets'

export interface ScreenshotDeps {
  /** PNG bytes of the live view, or null if missing/detached/off-screen/blank. */
  capture(id: string): Promise<Buffer | null>
  writeImage(png: Buffer): void
  currentDir(): string | null
  /** Persist the PNG into the project; resolves its `.canvas/`-relative path. */
  saveShot(dir: string, png: Uint8Array): Promise<{ relPath: string }>
}

export type ScreenshotResult =
  // BUG-028: `clipboardOk` reports whether the clipboard write actually landed —
  // previously a thrown writeImage was swallowed and `{ ok:true, relPath:null }`
  // read as "copied to clipboard" even when nothing was saved anywhere.
  // `relPath` is the saved file's path relative to `.canvas/` (`downloads/screenshot-….png` —
  // the same key the Project Library lists/reveals by), or null when nothing was saved.
  | { ok: true; relPath: string | null; clipboardOk: boolean }
  | { ok: false; reason: 'not-live' | 'forbidden' }

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `screenshot-YYYY-MM-DD-HHMMSS.png` in LOCAL time — sortable, and free of spaces/colons so the
 *  path survives a drag into a terminal or onto the canvas unquoted. */
export function screenshotFileName(now: Date): string {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  return `screenshot-${date}-${time}.png`
}

/** Saves run one at a time: `uniqueSavePath` picks a free name and the atomic write then claims
 *  it, so two captures landing in the same second would otherwise both pick the same name and
 *  the second rename would silently replace the first file. */
let saveQueue: Promise<unknown> = Promise.resolve()

/**
 * Write a screenshot into `<dir>/.canvas/downloads/` and resolve its `.canvas/`-relative path.
 * Never overwrites: a same-second capture gets the downloads' ` (1)` / ` (2)` suffix.
 */
export function saveScreenshot(
  dir: string,
  png: Uint8Array,
  now: Date = new Date()
): Promise<{ relPath: string }> {
  const run = saveQueue.then(async () => {
    const downloads = downloadsDirOf(dir)
    mkdirSync(downloads, { recursive: true }) // absent until the project's first download/shot
    const abs = uniqueSavePath(downloads, screenshotFileName(now), existsSync)
    await writeFileAtomic(abs, Buffer.from(png))
    return { relPath: `downloads/${basename(abs)}` }
  })
  saveQueue = run.catch(() => undefined) // a failed save must not wedge the next one
  return run
}

function realDeps(): ScreenshotDeps {
  return {
    // The Browser preview is an offscreen window; capture its last painted frame.
    capture: async (id) => await captureOsrPng(id),
    writeImage: (png) => clipboard.writeImage(nativeImage.createFromBuffer(png)),
    currentDir: () => getCurrentDir(),
    saveShot: (dir, png) => saveScreenshot(dir, png)
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
    if (!dir) return { ok: true, relPath: null, clipboardOk }
    try {
      const { relPath } = await deps.saveShot(dir, png)
      return { ok: true, relPath, clipboardOk }
    } catch (err) {
      // Disk full / locked / read-only: report success with no path rather than failing the
      // whole action (the clipboard copy may still have landed — `clipboardOk` says).
      // Log so it's diagnosable.
      console.warn('[preview:screenshot] save failed:', err)
      return { ok: true, relPath: null, clipboardOk }
    }
  })
}

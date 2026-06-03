/**
 * Env-gated MAIN test registry for the Playwright _electron harness (T4). Installed
 * ONLY when CANVAS_E2E is set; exposes the preview/pty internals the renderer hook
 * cannot see, plus the project/clipboard/input helpers the whiteboard slivers need.
 * Playwright reaches these via electronApp.evaluate(() => globalThis.__canvasE2EMain.*).
 *
 * This is a registry + an env flag — NOT a security change. sandbox / contextIsolation /
 * nodeIntegration are untouched; nothing here is reachable in a normal run.
 */
import { clipboard, nativeImage, type BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugCaptureView, debugViewIds, debugViewWebContentsId } from './preview'
import { debugTerminalPid, debugWriteTerminal } from './pty'
import { createProject, setCurrentDir } from './projectStore'

export interface E2EMain {
  terminalPid(id: string): number | null
  writeTerminal(id: string, data: string): boolean
  captureView(id: string): Promise<{ attached: boolean; empty: boolean }>
  viewIds(): string[]
  viewWebContentsId(id: string): number | null
  /** Real OS input through the live window (mouse/keyboard) — preserves transform hit-testing. */
  sendInput(evt: Parameters<BrowserWindow['webContents']['sendInputEvent']>[0]): void
  /** Mint a temp project dir + set it current (e2e has no project dir). Returns the path. */
  createTempProject(prefix: string, name: string): Promise<string>
  /** Clear the current dir + delete the temp project (best-effort). */
  teardownProject(tmp: string): void
  /** Put a w×h opaque-red RGBA bitmap on the system clipboard (for the paste sliver). */
  putRedBitmapOnClipboard(w: number, h: number): void
  /** True if an absolute path exists on disk (assert a pasted blob landed). */
  fileExists(absPath: string): boolean
  /** Join a temp-project path with a relative asset path (cross-platform). */
  joinPath(...parts: string[]): string
  /** The in-process local preview server URL — a deterministic page the browser probe seeds. */
  localUrl(): string
}

declare global {
  // eslint-disable-next-line no-var
  var __canvasE2EMain: E2EMain | undefined
}

/** Install the registry. No-op unless CANVAS_E2E is set. Call once after the window exists. */
export function installE2EMain(win: BrowserWindow, localUrl: string): void {
  if (!process.env.CANVAS_E2E) return
  globalThis.__canvasE2EMain = {
    terminalPid: debugTerminalPid,
    writeTerminal: debugWriteTerminal,
    captureView: debugCaptureView,
    viewIds: debugViewIds,
    viewWebContentsId: debugViewWebContentsId,
    sendInput(evt) {
      win.webContents.sendInputEvent(evt)
    },
    async createTempProject(prefix, name) {
      const tmp = mkdtempSync(join(tmpdir(), prefix))
      await createProject(tmp, name, {})
      setCurrentDir(tmp)
      return tmp
    },
    teardownProject(tmp) {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    },
    putRedBitmapOnClipboard(w, h) {
      const buf = Buffer.alloc(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 255 // R
        buf[i * 4 + 3] = 255 // A (G/B stay 0 → opaque red)
      }
      clipboard.clear()
      clipboard.writeImage(nativeImage.createFromBitmap(buf, { width: w, height: h }))
    },
    fileExists(absPath) {
      return existsSync(absPath)
    },
    joinPath(...parts) {
      return join(...parts)
    },
    localUrl() {
      return localUrl
    }
  }
}

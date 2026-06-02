import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerPtyHandlers, disposeAllPtys } from './pty'
import {
  registerPreviewHandlers,
  disposeAll as disposeAllPreviews,
  isAllowedExternal
} from './preview'
import { startLocalServer, type LocalServer } from './localServer'
import { runSelfTest } from './selfTest'
import { runE2ESmoke } from './e2e'
import { registerProjectHandlers } from './projectIpc'

let mainWindow: BrowserWindow | null = null
let localServer: LocalServer | null = null

const SMOKE = process.env.CANVAS_SMOKE // "1"=self-test, "exit"=self-test+quit, "e2e"=board harness+quit

// Smoke markers go to stdout. If the reader closes early (e.g. a truncated shell
// pipe like `pnpm start | Select-Object -First N`), the next write hits a dead
// pipe and throws EPIPE — which must NOT crash main with an uncaught-exception
// dialog. Swallow EPIPE on both the sync (throw) and async (stream 'error') paths.
if (SMOKE) process.stdout.on('error', () => {})

function smokeLog(line: string): void {
  try {
    console.log(line)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    title: 'Canvas ADE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // External links open in the OS browser, never in-app. The scheme is allowlisted
  // (Bug #23) so a stray window.open of file:/smb:/custom-protocol is dropped, not
  // handed to the OS handler.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Same-frame navigation guard (Bug #16/#47): the main window must never navigate
  // away from the app's own document — an accidental file/URL drop or a stray
  // location.assign would replace the whole React app (and every live PTY + native
  // preview view) with no in-app way back. Pin to the app origin; route an external
  // http(s) target to the OS browser, drop everything else. Compare ORIGIN (not the
  // full URL) so the e2e `?e2e=1` query / in-app hash changes don't trip the guard.
  const appOrigin = ((): string | null => {
    try {
      const dev = process.env['ELECTRON_RENDERER_URL']
      return dev ? new URL(dev).origin : null // packaged: file: origin is "null"
    } catch {
      return null
    }
  })()
  const guardNav = (event: { preventDefault: () => void }, url: string): void => {
    let origin: string | null
    try {
      const u = new URL(url)
      // Packaged app loads file://…/index.html — its URL origin is the string "null".
      origin = u.protocol === 'file:' ? null : u.origin
    } catch {
      event.preventDefault()
      return
    }
    if (origin === appOrigin) return // same app document — allow
    event.preventDefault()
    if (isAllowedExternal(url)) shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', (details, url) => guardNav(details, url))
  mainWindow.webContents.on('will-redirect', (details, url) => guardNav(details, url))
  // will-frame-navigate (Electron ≥22) covers subframes too — the renderer has none
  // today, but this keeps the guard complete if an iframe is ever added.
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame) guardNav(details, details.url)
  })

  // Surface renderer console to main stdout during smoke runs.
  if (SMOKE) {
    mainWindow.webContents.on('console-message', (_e, _lvl, message) => {
      if (message.startsWith('RENDERER_SMOKE')) smokeLog(message)
    })
  }

  // Dev-only HTML screenshot path (committed, env-gated). Captures the renderer DOM
  // (NOT the native WebContentsView — that's what the e2e Browser capture is for).
  // Usage: $env:CANVAS_SHOT='C:\tmp\canvas.png'; pnpm start
  // Skip when CANVAS_SMOKE=e2e: that run owns the did-finish-load lifecycle (and its
  // 800ms app.quit would cut the multi-second e2e harness short).
  const shotPath = process.env.CANVAS_SHOT
  if (shotPath && SMOKE !== 'e2e') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow!.webContents.capturePage()
          writeFileSync(shotPath, img.toPNG())
          smokeLog(`CANVAS_SHOT_DONE ${shotPath}`)
        } catch (err) {
          smokeLog(`CANVAS_SHOT_FAIL ${(err as Error).message}`)
        }
        app.quit()
      }, 800)
    })
  }

  const e2e = SMOKE === 'e2e'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    mainWindow.loadURL(e2e ? `${base}?e2e=1` : base)
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      e2e ? { query: { e2e: '1' } } : undefined
    )
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.canvasade.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // The local preview server is a convenience (dev/preview fallback URL), not a hard
  // boot dependency. If listen() fails (EACCES from AV/firewall loopback denial,
  // EMFILE/ENFILE under fd exhaustion, ENETDOWN), surface a clear diagnostic and
  // degrade gracefully — boot the window with an empty fallback URL rather than
  // crashing to app.exit(1) via the uncaughtException sink with no message.
  let defaultPreviewUrl = ''
  try {
    localServer = await startLocalServer()
    defaultPreviewUrl = localServer.url
  } catch (err) {
    console.error(
      'Could not bind local preview server on 127.0.0.1 — continuing without it. ' +
        'Boards open with an explicit URL still work.',
      err
    )
  }
  registerPtyHandlers(ipcMain, () => mainWindow)
  registerPreviewHandlers(ipcMain, () => mainWindow, defaultPreviewUrl)
  registerProjectHandlers(ipcMain, () => mainWindow, app.getPath('userData'))

  createWindow()

  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      if (SMOKE === 'e2e') {
        const code = await runE2ESmoke(mainWindow!, localServer!.url)
        process.exitCode = code
        // app.exit() (not app.quit()): on Windows app.quit() ignores process.exitCode,
        // so the harness exit code wouldn't reach the shell. app.exit() propagates it
        // but bypasses `before-quit` — so flush the renderer autosave (BUG-M2) and call
        // shutdown() explicitly first to drain the PTY tree / preview views / local
        // server (shutdown is idempotent). AWAIT the drain (the PTY tree-kill is now
        // awaitable, #49) before exiting so a deep child tree is reaped instead of
        // orphaned by a fixed timer race.
        await flushRenderer()
        await shutdown()
        app.exit(code)
      } else {
        const ok = await runSelfTest(mainWindow!, localServer!.url)
        smokeLog(`SELFTEST_DONE ${JSON.stringify(ok)}`)
        if (SMOKE === 'exit') setTimeout(() => app.quit(), 400)
      }
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Idempotent teardown of every native resource (PTY trees, preview views, local
 * server). Returns a Promise that resolves once the PTY tree-kill is reaped (#49)
 * so the abrupt `app.exit` and guarded `before-quit` paths can await it; the crash
 * hooks fire it best-effort without awaiting (an uncaughtException handler can't).
 */
function shutdown(): Promise<void> {
  const drained = disposeAllPtys()
  disposeAllPreviews()
  localServer?.close()
  localServer = null
  return drained
}

/**
 * Ask the renderer to flush its debounced autosave before we hard-exit (BUG-M2).
 * The quit path calls `app.exit(0)`, which never fires the renderer `beforeunload`,
 * so the autosave flush handler (useAutosave) would be skipped and the last ~1s of
 * edits lost. We post `project:flush` with a unique reply channel; the renderer runs
 * its flush (awaiting `project:save`) and replies. We resolve on the reply OR a short
 * timeout fallback so a wedged/closed renderer can never hang the quit.
 */
function flushRenderer(timeoutMs = 1500): Promise<void> {
  const win = mainWindow
  const wc = win?.webContents
  if (!win || !wc || wc.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const replyChannel = `project:flush:done:${Date.now()}:${Math.random().toString(36).slice(2)}`
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      ipcMain.removeAllListeners(replyChannel)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    ipcMain.once(replyChannel, finish)
    try {
      wc.send('project:flush', replyChannel)
    } catch {
      finish() // renderer gone — nothing to flush
    }
  })
}

app.on('window-all-closed', () => {
  // Route through app.quit() (non-darwin) so the guarded before-quit handler below
  // performs the awaited PTY-tree drain (#49) instead of racing a fire-and-forget
  // shutdown() against process exit.
  if (process.platform !== 'darwin') app.quit()
})

// Guarded async quit (#49/BUG-031): on first entry, defer the quit, flush the renderer
// autosave (BUG-M2 — the hard app.exit bypasses the renderer beforeunload), drain the
// PTY tree (bounded by shutdown()'s own 2s timeout) so a deep agent child tree is reaped
// instead of orphaned, then exit. The `quitting` flag lets the post-drain app.exit(0)
// proceed without re-deferring.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void flushRenderer()
    .then(() => shutdown())
    .finally(() => app.exit(0))
})

// Crash-path / signal cleanup (#50): before-quit/window-all-closed don't fire on an
// uncaught error or an external SIGINT/SIGTERM, which would orphan the node-pty child
// trees. shutdown() is idempotent, so firing it here (in addition to the normal paths)
// is safe. An uncaughtException handler can't await the async taskkill before exit, so
// this is best-effort — but firing the tree-kill at all beats the zero-cleanup path.
let crashing = false
function crashShutdown(exitCode: number, err?: unknown): void {
  if (crashing) return
  crashing = true
  if (err) console.error(err)
  void shutdown()
  app.exit(exitCode)
}
process.on('uncaughtException', (err) => crashShutdown(1, err))
process.on('unhandledRejection', (reason) => crashShutdown(1, reason))
process.on('SIGINT', () => crashShutdown(0))
process.on('SIGTERM', () => crashShutdown(0))

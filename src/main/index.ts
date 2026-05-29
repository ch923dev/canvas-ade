import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerPtyHandlers, disposeAllPtys } from './pty'
import { registerPreviewHandlers, disposeAll as disposeAllPreviews } from './preview'
import { startLocalServer, type LocalServer } from './localServer'
import { runSelfTest } from './selfTest'
import { runE2ESmoke } from './e2eSmoke'

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

  // External links open in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
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
  const shotPath = process.env.CANVAS_SHOT
  if (shotPath) {
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

  localServer = await startLocalServer()
  registerPtyHandlers(ipcMain, () => mainWindow)
  registerPreviewHandlers(ipcMain, () => mainWindow, localServer.url)

  createWindow()

  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      if (SMOKE === 'e2e') {
        const code = await runE2ESmoke(mainWindow!, localServer!.url)
        process.exitCode = code
        // app.exit() (not app.quit()): on Windows app.quit() ignores process.exitCode,
        // so the harness exit code wouldn't reach the shell. app.exit() propagates it
        // but bypasses `before-quit` — so call shutdown() explicitly first to drain the
        // PTY tree / preview views / local server (shutdown is idempotent).
        setTimeout(() => {
          shutdown()
          app.exit(code)
        }, 400)
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

function shutdown(): void {
  disposeAllPtys()
  disposeAllPreviews()
  localServer?.close()
  localServer = null
}

app.on('window-all-closed', () => {
  shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', shutdown)

import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerPtyHandlers, disposeAllPtys } from './pty'
import { registerPreviewHandlers, disposeAll as disposeAllPreviews } from './preview'
import { startLocalServer, type LocalServer } from './localServer'
import { runSelfTest } from './selfTest'

let mainWindow: BrowserWindow | null = null
let localServer: LocalServer | null = null

const SMOKE = process.env.CANVAS_SMOKE // "1" = run self-test, "exit" = self-test then quit

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
      if (message.startsWith('RENDERER_SMOKE')) console.log(message)
    })
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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
      const ok = await runSelfTest(mainWindow!, localServer!.url)
      console.log(`SELFTEST_DONE ${JSON.stringify(ok)}`)
      if (SMOKE === 'exit') {
        setTimeout(() => app.quit(), 400)
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

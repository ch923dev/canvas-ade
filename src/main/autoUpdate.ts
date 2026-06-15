// src/main/autoUpdate.ts
/**
 * electron-updater wiring (Phase 5). A small, dependency-injected module so the
 * security gate + event forwarding are unit-testable WITHOUT loading electron-updater
 * or a real BrowserWindow. The real `autoUpdater` is imported only in index.ts and
 * passed in via `getUpdater` — this file stays runtime-free of electron-updater so a
 * node unit test can import it directly.
 *
 * SECURITY GATE: initAutoUpdate is a COMPLETE NO-OP unless `enabled` AND `isPackaged`.
 * `enabled` is the __ENABLE_AUTO_UPDATE__ build constant (electron.vite.config.ts),
 * true ONLY for signed production builds — the production CI job sets ENABLE_AUTO_UPDATE=1
 * exclusively when code-signing secrets are present. So an unsigned build never wires the
 * updater and never reaches checkForUpdates, enforcing the "no unsigned auto-update over a
 * feed" invariant (electron-builder.yml `publish`) in code rather than by convention.
 * `getUpdater` is invoked ONLY once the gate is open, so an unsigned/test run never even
 * resolves electron-updater.
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { isForeignSender } from './ipcGuard'

/** Status pushed main → renderer on the `update:status` channel. Mirrors preload `UpdateStatus`. */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/** electron-updater event payloads carry these fields (UpdateInfo / ProgressInfo / Error). */
type UpdaterEventArg = { version?: string; percent?: number; message?: string }

/** The slice of electron-updater's autoUpdater we use (injectable for tests). */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (info: UpdaterEventArg) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export interface AutoUpdateDeps {
  /** The __ENABLE_AUTO_UPDATE__ build constant — true only for signed production builds. */
  enabled: boolean
  isPackaged: boolean
  ipc: IpcMain
  getWin: () => BrowserWindow | null
  /**
   * Lazily resolve electron-updater's autoUpdater — invoked (and awaited) ONLY when the
   * gate is open. index.ts wires this to a dynamic `import('electron-updater')`, so an
   * unsigned build never even loads electron-updater (nor needs its transitive deps —
   * e.g. semver — packed). That removes a real boot-crash risk for unsigned packages.
   */
  getUpdater: () => Promise<UpdaterLike>
  logError?: (...args: unknown[]) => void
}

export async function initAutoUpdate(deps: AutoUpdateDeps): Promise<void> {
  const { enabled, isPackaged, ipc, getWin, getUpdater } = deps
  const logError = deps.logError ?? ((...a: unknown[]): void => console.error(...a))

  // Gate: unsigned / non-packaged builds wire NOTHING (see the security note above).
  if (!enabled || !isPackaged) return

  const updater = await getUpdater()

  // Push a status to the renderer, guarding a destroyed-but-non-null window (BUG-001):
  // accessing .webContents on a destroyed window throws, so check isDestroyed() first.
  const send = (status: UpdateStatus): void => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send('update:status', status)
  }

  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true

  updater.on('checking-for-update', () => send({ state: 'checking' }))
  updater.on('update-available', (info) =>
    send({ state: 'available', version: info.version ?? '' })
  )
  updater.on('update-not-available', () => send({ state: 'none' }))
  updater.on('download-progress', (info) =>
    send({ state: 'downloading', percent: Math.round(info.percent ?? 0) })
  )
  updater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version ?? '' }))
  updater.on('error', (info) => {
    logError('[auto-update] error', info)
    send({ state: 'error', message: info.message ?? 'update failed' })
  })

  // The only renderer-triggered action: install the downloaded update + relaunch. The
  // renderer fires this from the "ready" update toast. Frame-guarded like every IPC.
  ipc.handle('update:install', (e) => {
    if (isForeignSender(e, getWin)) return false
    try {
      updater.quitAndInstall()
    } catch (err) {
      logError('[auto-update] quitAndInstall failed', err)
    }
    return true
  })

  // Kick off the initial check. Rejections surface via the 'error' event above; also
  // caught here so a transient feed/network failure never reaches the uncaughtException sink.
  updater.checkForUpdates().catch((err) => logError('[auto-update] checkForUpdates failed', err))
}

/**
 * Phase 1 (accounts): the auth IPC surface. A thin, frame-guarded wrapper over AuthService — every
 * handler runs isForeignSender first, and NONE return a token (auth:status carries presence/email/
 * plan only, mirroring llmKeyStore's hasKey discipline). The auth:statusChanged push mirrors
 * autoUpdate's update:status (wc.send, destroyed-window-guarded).
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import type { AuthService, AuthStatus } from './authService'

export function registerAuthHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  auth: AuthService
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('auth:status', (e): AuthStatus => {
    // A foreign frame gets the safe signed-out shape — never a real session read.
    if (guard(e)) return { isLoggedIn: false, encryptionAvailable: false }
    return auth.status()
  })

  ipcMain.handle('auth:signIn', (e): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    return auth.signIn()
  })

  ipcMain.handle('auth:signOut', async (e): Promise<{ ok: boolean }> => {
    if (guard(e)) return { ok: false }
    return auth.signOut()
  })
}

/**
 * Push the current auth status to the renderer on the auth:statusChanged channel. Guards a
 * destroyed-but-non-null window (accessing .webContents on a destroyed window throws), exactly like
 * autoUpdate's send().
 */
export function pushAuthStatus(getWin: () => BrowserWindow | null, status: AuthStatus): void {
  const win = getWin()
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc.isDestroyed()) wc.send('auth:statusChanged', status)
}

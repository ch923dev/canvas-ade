/**
 * One-call boot wiring for the PR-2 background-sessions UX (the wireLifecycleNotifications /
 * recapHealth extraction precedent — index.ts is at its max-lines ratchet, so it adds a single
 * statement here instead of the notifications + config-IPC + close-guard + tray plumbing).
 * The #314 lifecycle-notifications wiring moved INSIDE this call so its `deliver` handle can
 * feed the tray's background-exit toasts without index.ts holding the handle. The close guard
 * itself attaches per-window in createWindow (attachCloseGuard, re-exported here) because it
 * must re-arm on every window (re)creation, including a reopen from the tray.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { configureCloseGuard, registerPtyHostConfigIpc } from './closeGuard'
import { flushRendererAutosave } from './flushChannel'
import { wireLifecycleNotifications } from './lifecycleNotifications'
import { persistBackgroundRingTails } from './pty'
import { appendTerminalSnapshot } from './terminalSnapshot'
import { wireTrayResidency } from './trayResidency'

export { isTrayResident } from './trayResidency'

export interface BackgroundSessionsBootDeps {
  getWin: () => BrowserWindow | null
  /** Recreate the app window on a tray reopen (index.ts createWindow). */
  createWindow: () => void
  /** The REAL userData dir (config + notification prefs) — never a project folder. */
  userData: string
}

export function wireBackgroundSessionsUx(deps: BackgroundSessionsBootDeps): void {
  // Desktop notifications (#314): registers notifications:* IPC, the Claude-path watcher and
  // the generic-PTY route — exactly the call index.ts used to make directly; the returned
  // deliver handle is the ONE delivery site the tray's background-exit toasts ride.
  const recapMapPath = join(deps.userData, 'recap', 'session-map.jsonl')
  const lifecycle = wireLifecycleNotifications(deps.getWin, recapMapPath, deps.userData)
  configureCloseGuard({ userData: deps.userData })
  registerPtyHostConfigIpc(ipcMain, deps.getWin, deps.userData)
  wireTrayResidency({
    createWindow: deps.createWindow,
    // The guarded-quit renderer flush, bounded — same primitive index.ts's flushRenderer wraps.
    flushRenderer: () => flushRendererAutosave(ipcMain, deps.getWin, 1500),
    persistRingTails: () => persistBackgroundRingTails(appendTerminalSnapshot),
    destroyWindow: () => {
      const win = deps.getWin()
      if (win && !win.isDestroyed()) win.destroy()
    },
    deliver: lifecycle.deliver,
    userData: deps.userData
  })
}

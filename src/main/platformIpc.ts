/**
 * Platform info exposed to the renderer (SYNC). Currently just the Windows OS BUILD number, which the
 * terminal reads to set xterm's `windowsPty` hint at construction — see useTerminalSpawn (A-Win,
 * docs/research/2026-06-23-terminal-scrollback-reflow § A-Win). Telling xterm the ConPTY build aligns
 * its resize/scrollback handling with ConPTY's own screen reprint, cutting the xterm⇄ConPTY
 * double-layout that duplicates/garbles rows on a resize. Exposed SYNC (the preload reads it once via
 * sendSync) so the value is present the instant the first Terminal mounts — no async race against
 * xterm construction. Returns null off Windows.
 */
import type { IpcMain } from 'electron'
import { release } from 'os'
import { computeE2ESurfaceEnabled } from './windowSecurity'

/** Parse the Windows build from an `os.release()` string ("10.0.22631" → 22631). Null if unparseable. */
export function winBuildFromRelease(rel: string): number | null {
  const m = /^\d+\.\d+\.(\d+)/.exec(rel)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export function registerPlatformIpc(ipcMain: IpcMain): void {
  // SYNC (ipcMain.on + returnValue): the preload reads this ONCE at load so the renderer has the build
  // number synchronously when constructing xterm. A static, cheap, one-time value — sendSync's block
  // is negligible and avoids an async race for the very first terminal mount.
  ipcMain.on('platform:winBuild', (e) => {
    e.returnValue = process.platform === 'win32' ? winBuildFromRelease(release()) : null
  })

  // BUG-057: same SYNC-at-load pattern, MAIN-owned — the renderer's e2e test-surface gate
  // (`isE2E` in e2eRegistry.ts) reads this instead of the client-mutable `?e2e=1` URL query.
  ipcMain.on('platform:e2eEnabled', (e) => {
    e.returnValue = computeE2ESurfaceEnabled()
  })
}

/**
 * OSR offscreen-window capture + crash helpers. Split out of previewOsr.ts (max-lines budget):
 * both reach the live offscreen window via `getOsrWindow` rather than the private `osr` Map.
 *
 * - `captureOsrPng` is the production screenshot capture path (previewScreenshot.ts) AND the e2e
 *   evidence path (e2eMain `captureOsrToFile`).
 * - `debugCrashOsr` is E2E ONLY (the crashed-recovery probe).
 *
 * Not a security change — exposes nothing a previewed page couldn't already do to itself.
 */
import { getOsrWindow } from './previewOsr'

/**
 * Capture a board's OSR offscreen window as PNG bytes, or null if missing / blank. The user-facing
 * screenshot IPC (previewScreenshot.ts) tries the native view first, then this — OSR is the default
 * engine since OS-3 Phase 5. The offscreen window paints continuously while the board is on-screen
 * (paint-gated only when off-screen), so `capturePage()` returns the last painted frame. Mirrors
 * `captureViewPng`'s blank/rejection handling.
 */
export async function captureOsrPng(id: string): Promise<Buffer | null> {
  const win = getOsrWindow(id)
  if (!win) return null
  try {
    const img = await win.webContents.capturePage()
    return img.isEmpty() ? null : img.toPNG()
  } catch {
    // No composited offscreen surface (headless / GPU-contended host): treat as not-capturable.
    return null
  }
}

/**
 * E2E ONLY — forcefully crash a board's OSR renderer process (the OSR analogue of the native
 * `debugCrashView`). SIGKILLs the offscreen window's renderer OS pid, which fires
 * `render-process-gone` (`reason: 'killed'`) → the renderer maps it to status `crashed`
 * (useOffscreenPreview.ts), then the Reload CTA recreates the window. Returns false when no OSR
 * window exists. Uses the OS kill rather than `forcefullyCrashRenderer()` — the Chromium call is a
 * SILENT NO-OP under some containerized kernels (the Linux-Docker leg, 2026-06-13), while the OS
 * kill fires identically on every platform (Node maps SIGKILL → TerminateProcess on Windows).
 */
export function debugCrashOsr(id: string): boolean {
  const win = getOsrWindow(id)
  if (!win) return false
  try {
    const pid = win.webContents.getOSProcessId()
    if (pid > 0) {
      process.kill(pid, 'SIGKILL')
    } else {
      win.webContents.forcefullyCrashRenderer()
    }
    return true
  } catch {
    return false
  }
}

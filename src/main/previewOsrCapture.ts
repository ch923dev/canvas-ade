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

/**
 * E2E ONLY — deterministically verify the production first-ready repaint CONTRACT: the
 * `registerCrashReadyGate` onReady callback (previewOsr.ts) must pair `wc.invalidate()` with
 * `wc.startPainting()` so an IDLE page that missed its implicit begin-frame still gets one fresh
 * frame. This is the regression guard for the PR #210 idle-page blank.
 *
 * WHY A CONTRACT SPY, NOT A PIXEL ASSERTION: the live failure is a timing-dependent CDP scheduler
 * race (armOsrNetwork's Network.enable + Target.setAutoAttach on the did-finish-load tick consuming
 * the idle page's single implicit begin-frame). Under headless Windows OSR that race does NOT
 * surface — `startPainting()` reliably emits a frame here — so a pixel-level "stays blank" assertion
 * cannot be made RED in this environment (confirmed empirically). What IS deterministic across every
 * environment is the code path: with the fix onReady calls `invalidate()`; without it, it does not.
 * Spying the real `onReady` closure makes the test reliably RED-without (0 invalidate calls) and
 * GREEN-with (≥1), exercising the exact production listener over a live, already-loaded idle board.
 *
 * Mechanism — instrument `wc.invalidate` with a counter, then re-emit `did-finish-load` (re-runs the
 * SAME listeners the first real load runs — registerLoadLatch + registerCrashReadyGate.onReady —
 * over unchanged content, no navigation). The desired paint flag is left true so onReady's
 * `if (!e.painting) return` guard is not taken and its repaint branch runs. Returns the number of
 * `invalidate()` calls onReady made on that tick (≥1 with the fix, 0 without), or -1 when no OSR
 * window. The original `invalidate` is restored before returning (no leaked instrumentation).
 */
export function debugReplayOsrReadyInvalidations(id: string): number {
  const wc = getOsrWindow(id)?.webContents
  if (!wc || wc.isDestroyed()) return -1
  const original = wc.invalidate.bind(wc)
  let calls = 0
  try {
    // Count invalidate() calls triggered by the re-emitted did-finish-load (i.e. by onReady).
    ;(wc as unknown as { invalidate: () => void }).invalidate = () => {
      calls++
      original()
    }
    // WebContents is an EventEmitter; re-emitting did-finish-load re-runs every registered listener
    // over the live, idle, already-loaded page — no navigation, no content change.
    ;(wc as unknown as { emit: (event: string) => void }).emit('did-finish-load')
    return calls
  } catch {
    return -1
  } finally {
    // Always restore the real method so no spy leaks into later frames/tests.
    ;(wc as unknown as { invalidate: () => void }).invalidate = original
  }
}

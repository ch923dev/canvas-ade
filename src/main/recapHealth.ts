/**
 * F4 (terminal-resume research, RC-3): hook-health surfacing + the focus-time self-heal.
 *
 * The capture hook dies SILENTLY: a packaged build with no `node` on PATH never installs it
 * (recapRunner === null, one console.warn nobody sees); third-party tooling can clobber
 * `<project>/.claude/settings.local.json` mid-session (the re-ensure previously ran only on
 * project OPEN); and the user's only symptom for any of it is "Resume never appears".
 *
 * Three small seams, all pure + deps-injected so index.ts stays thin:
 *  - `recap:health` (frame-guarded IPC): per-board { runner, hookInstalled, captured } for the
 *    Inspector's fault-only status line. Consent-off returns null — capture being off is then
 *    EXPECTED, and the calm/dense doctrine says render nothing rather than warn about a choice.
 *  - `createFocusReEnsure`: the browser-window-focus handler body — re-runs the idempotent
 *    installRecapHook for the open consented project, healing a mid-session clobber without
 *    waiting for the next project open. Best-effort; never throws out of a focus event.
 *  - `selectTranscriptClocks` (#295 carry-in): the A4 clock selection for resolveBoardTranscript,
 *    now also matching the map entry's CONFIRMED capture path — so a confirmed session that
 *    itself rotates while its old file survives adopts the successor instead of resuming the
 *    pre-rotation id (stale fork).
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import { safeBoardId } from './canvasMemory'
import type { RecapMapEntry } from './agentRecapMap'

/** What the Inspector's status line renders from. MIRRORED in src/preload/recapApi.ts. */
export interface RecapHealth {
  /** 'missing' = packaged build found no `node` on PATH → the hook was never installed. */
  runner: 'ok' | 'missing'
  /** F2's all-events isRecapHookInstalled against THIS build's recordSession.js path. */
  hookInstalled: boolean
  /** The live recap map has ANY entry for this board (eager or confirmed) — the hook fired. */
  captured: boolean
  /**
   * Ms since the board's PTY session spawned (null = no live session). MAIN's clock, so the
   * renderer's no-capture grace can't drift across respawns or renderer remounts.
   */
  sessionAgeMs: number | null
}

export interface RecapHealthDeps {
  getWin: () => BrowserWindow | null
  getCurrentDir: () => string | null
  /** True when the project's recap consent decision is 'enabled'. */
  isConsented: (dir: string) => boolean
  /** recapRunner non-null (dev: always; packaged: a real node resolved from PATH). */
  runnerOk: () => boolean
  hookInstalled: (dir: string) => boolean
  hasCapture: (boardId: string) => boolean
  /** Boot age of the board's live PTY session (getTerminalBootInfo), null when none. */
  sessionAgeMs: (boardId: string) => number | null
}

/**
 * Pure health resolver. Null (render nothing) when no project is open or the project has not
 * consented — a fault line only makes sense where capture is SUPPOSED to be on.
 */
export function computeRecapHealth(
  deps: Omit<RecapHealthDeps, 'getWin'>,
  boardId: string
): RecapHealth | null {
  const dir = deps.getCurrentDir()
  if (!dir || !deps.isConsented(dir)) return null
  return {
    runner: deps.runnerOk() ? 'ok' : 'missing',
    hookInstalled: deps.hookInstalled(dir),
    captured: deps.hasCapture(boardId),
    sessionAgeMs: deps.sessionAgeMs(boardId)
  }
}

export function registerRecapHealthIpc(ipcMain: IpcMain, deps: RecapHealthDeps): void {
  ipcMain.handle('recap:health', (e: IpcMainInvokeEvent, boardId: unknown): RecapHealth | null => {
    if (isForeignSender(e, deps.getWin)) return null
    // BUG-032 discipline: enforce safeBoardId at IPC ingress before any work.
    if (typeof boardId !== 'string' || !safeBoardId(boardId)) return null
    return computeRecapHealth(deps, boardId)
  })
}

export interface FocusReEnsureDeps {
  getCurrentDir: () => string | null
  isConsented: (dir: string) => boolean
  runnerOk: () => boolean
  /** installRecapHook for the dir — idempotent + no-op-write-guarded, so per-focus is cheap. */
  install: (dir: string) => void
}

/**
 * The browser-window-focus handler: re-ensure the recap hook for the open CONSENTED project.
 * A clobbered settings.local.json heals on the next alt-tab back instead of the next project
 * open. Swallows install errors — a broken settings file must never break window focus.
 */
export function createFocusReEnsure(deps: FocusReEnsureDeps): () => void {
  return () => {
    try {
      const dir = deps.getCurrentDir()
      if (!dir || !deps.isConsented(dir) || !deps.runnerOk()) return
      deps.install(dir)
    } catch {
      /* best-effort heal */
    }
  }
}

/**
 * #295 carry-in: which map-entry clocks (sessionId = lineage anchor, recordedAt = eager-grace
 * clock) apply to a recorded transcript path in resolveBoardTranscript. The top-level entry
 * fields win when the path IS the entry's; the F2 CONFIRMED capture's clocks apply when the
 * path is the confirmed one (previously never matched → a rotated confirmed session resumed
 * the pre-rotation id). A divergent persisted board path matches neither → legacy behavior.
 */
export function selectTranscriptClocks(
  entry: RecapMapEntry | undefined,
  recorded: string | undefined
): { sessionId?: string; recordedAt?: number } {
  if (!entry || !recorded) return {}
  if (entry.transcriptPath === recorded) {
    return { sessionId: entry.sessionId, recordedAt: entry.ts }
  }
  const c = entry.confirmed
  if (c && c.transcriptPath === recorded) {
    // readRecapMap defaults a missing confirmed sessionId to '' — pass undefined instead so
    // resolveLiveTranscriptPath never anchors lineage on an empty string.
    return { sessionId: c.sessionId || undefined, recordedAt: c.ts }
  }
  return {}
}

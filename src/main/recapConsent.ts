/**
 * Per-project recap-consent store + recap:* IPC handlers.
 *
 * Decision values: 'enabled' | 'declined'. Absent key = undecided (undefined).
 * Stored in `<userDataDir>/recap-consent.json` (never in the project folder).
 * Pure file I/O keyed by an explicit userDataDir for testability (no Electron `app`).
 * Mirrors the llmConfig.ts pattern.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'

export type RecapDecision = 'enabled' | 'declined'

/**
 * BUG-022: canonicalize a project-root path before it becomes a consent-store KEY.
 * `getCurrentDir()` returns whatever `project:open`/`project:create` was given verbatim (a
 * dialog/recents path string, no `path.resolve`/case-fold anywhere upstream) — so the SAME
 * project directory reopened via a differently-spelled-but-equivalent path (a trailing
 * separator, or a case difference on Windows/macOS-default's case-insensitive filesystem) would
 * otherwise silently miss the stored decision and re-prompt the user. Mirrors the Windows-style
 * case-fold already used for the create/open approved-root check (`isWindowsStylePath`/
 * `pathSegments`, FIND-014, `projectIpc.ts`) — POSIX paths stay case-sensitive. Deliberately does
 * NOT route through `path.normalize` (it flips `/` to `\` on win32, which would rewrite a
 * POSIX-shaped path's separators and change the key's shape); just trims a trailing separator and
 * case-folds Windows-style paths. Local to the consent-store KEY only; never touches `currentDir`
 * itself or any other getCurrentDir() consumer.
 */
function canonicalizeProjectPath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
    ? trimmed.toLowerCase()
    : trimmed
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'recap-consent.json')
}

function readAll(userDataDir: string): Record<string, RecapDecision> {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    const out: Record<string, RecapDecision> = {}
    for (const [k, v] of Object.entries(p)) {
      if (v === 'enabled' || v === 'declined') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Read the persisted consent decision for a project. Returns undefined when undecided. */
export function readConsent(userDataDir: string, projectPath: string): RecapDecision | undefined {
  return readAll(userDataDir)[canonicalizeProjectPath(projectPath)]
}

/** Persist a consent decision for a project. Atomic write (write-file-atomic). */
export function writeConsent(
  userDataDir: string,
  projectPath: string,
  decision: RecapDecision
): void {
  const all = readAll(userDataDir)
  all[canonicalizeProjectPath(projectPath)] = decision
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(all, null, 2), 'utf8')
}

/** Remove a project's persisted consent decision (→ undecided). Atomic. Used to roll back a write
 * whose follow-on hook install/remove failed (FIND-012). No-op when the key is absent. */
export function clearConsent(userDataDir: string, projectPath: string): void {
  const key = canonicalizeProjectPath(projectPath)
  const all = readAll(userDataDir)
  if (!(key in all)) return
  delete all[key]
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(all, null, 2), 'utf8')
}

/**
 * Register the recap:getConsent / recap:setConsent IPC handlers.
 *
 * @param ipcMain       Electron's ipcMain (or a fake in tests).
 * @param getWin        Returns the trusted BrowserWindow (for the foreign-sender guard).
 * @param userDataDir   Explicit userData path; never read from `app` so it is testable.
 * @param getCurrentDir Returns the currently open project directory, or null when none.
 * @param onDecision    Called after a consent decision is persisted (install / remove hook).
 */
export function registerRecapHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  getCurrentDir: () => string | null,
  onDecision: (projectPath: string, decision: RecapDecision) => void
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('recap:getConsent', (e): RecapDecision | 'undecided' => {
    if (guard(e)) return 'declined'
    const dir = getCurrentDir()
    if (!dir) return 'declined'
    return readConsent(userDataDir, dir) ?? 'undecided'
  })

  ipcMain.handle('recap:setConsent', (e, decision: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const dir = getCurrentDir()
    if (!dir || (decision !== 'enabled' && decision !== 'declined')) return { ok: false }
    // FIND-012: persist FIRST, then install/remove the hook — but if onDecision throws (e.g.
    // installRecapHook fails writing .claude/settings.local.json), the consent would be left
    // 'enabled' while the recording hook is uninstalled: a durable desync (recap silently records
    // nothing) until the next project open re-ensures it. Roll the consent write back to its prior
    // state so the stored decision always matches what onDecision actually achieved, and report
    // failure so the renderer doesn't show the toggle as flipped.
    const prior = readConsent(userDataDir, dir)
    writeConsent(userDataDir, dir, decision)
    try {
      onDecision(dir, decision) // install or remove the session hook
    } catch (err) {
      console.error(
        '[recap] consent hook install/remove failed; rolling back persisted consent',
        err
      )
      try {
        if (prior === undefined) clearConsent(userDataDir, dir)
        else writeConsent(userDataDir, dir, prior)
      } catch {
        /* best-effort rollback — never throw out of the IPC handler */
      }
      return { ok: false }
    }
    return { ok: true }
  })
}

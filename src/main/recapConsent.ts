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
  return readAll(userDataDir)[projectPath]
}

/** Persist a consent decision for a project. Atomic write (write-file-atomic). */
export function writeConsent(
  userDataDir: string,
  projectPath: string,
  decision: RecapDecision
): void {
  const all = readAll(userDataDir)
  all[projectPath] = decision
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
    writeConsent(userDataDir, dir, decision)
    onDecision(dir, decision) // install or remove the session hook
    return { ok: true }
  })
}

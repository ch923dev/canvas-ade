/**
 * Per-project ORCHESTRATION consent store + orchestration:* IPC handlers
 * (Agent Orchestration Onboarding, P1 — 2026-06-19). Backs the one-time
 * "Enable agent orchestration?" grant (the mock's Step 1).
 *
 * Decision values: 'enabled' | 'declined'. Absent key = undecided (undefined).
 * Stored in `<userDataDir>/orchestration-consent.json` (NEVER the project folder —
 * CLAUDE.md persistence rule). Pure file I/O keyed by an explicit userDataDir for
 * testability (no Electron `app`). Mirrors recapConsent.ts — a SEPARATE consent from
 * recap (decision 2026-06-19): different authority grant, different store file.
 *
 * This module also BACKS the shared seam (`orchestration/seam.ts`): index.ts binds a
 * userDataDir at boot (`bindConsentStore`, done as a side effect of registering the
 * handlers), and the seam's `isOrchestrationEnabled` / `setOrchestrationEnabled` resolve
 * through `isEnabled` / `setEnabled` here — so MAIN consumers that only know a `projectDir`
 * (the P3 spawn-time provisioner hook, the P0 plan-write gate) read consent without
 * threading userDataDir everywhere. The binding lives here (not in the seam) so the seam
 * stays Electron-free and unit-testable.
 *
 * Security (PLAN §6): consent is the PROD authority that replaces the dev-only plan-write
 * flag and gates the spawn-time provisioner sync; the per-action ConfirmModal gate is never
 * weakened by it. No tokens are read or written here.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'

export type OrchestrationDecision = 'enabled' | 'declined'
/** What the renderer sees: a real decision, or 'undecided' when no key is stored. */
export type OrchestrationConsentState = OrchestrationDecision | 'undecided'

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'orchestration-consent.json')
}

function readAll(userDataDir: string): Record<string, OrchestrationDecision> {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    const out: Record<string, OrchestrationDecision> = {}
    for (const [k, v] of Object.entries(p)) {
      if (v === 'enabled' || v === 'declined') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Read the persisted decision for a project. Returns undefined when undecided. */
export function readDecision(
  userDataDir: string,
  projectPath: string
): OrchestrationDecision | undefined {
  return readAll(userDataDir)[projectPath]
}

/** Persist a decision for a project. Atomic write (write-file-atomic). */
export function writeDecision(
  userDataDir: string,
  projectPath: string,
  decision: OrchestrationDecision
): void {
  const all = readAll(userDataDir)
  all[projectPath] = decision
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(all, null, 2), 'utf8')
}

// ── Seam binding ──────────────────────────────────────────────────────────────────────
// The seam (orchestration/seam.ts) exposes isOrchestrationEnabled(projectDir) /
// setOrchestrationEnabled(projectDir, on) to MAIN consumers that only know a projectDir. They
// resolve userData through this module-level binding, set once at boot. Kept here (not in the
// seam) so the seam module stays free of fs/electron and remains a pure unit-test target.
let boundUserDataDir: string | null = null

/** Bind the userData dir the seam reads/writes through. Idempotent; called once at boot. */
export function bindConsentStore(userDataDir: string): void {
  boundUserDataDir = userDataDir
}

/** Seam getter: is orchestration enabled for this project? Closed (false) until bound. */
export function isEnabled(projectPath: string): boolean {
  if (!boundUserDataDir) return false
  return readDecision(boundUserDataDir, projectPath) === 'enabled'
}

/**
 * Seam setter: persist a boolean grant for this project. Persist-ONLY — the IPC handler
 * (`orchestration:setConsent`) is the user-facing path that ALSO fires `onChange` to drive the
 * P3 provisioner sync/unsync. Throws if the store was never bound so a consent write can never
 * silently no-op (an unbound write would lose the grant + leave the spawn hook reading stale
 * state).
 */
export function setEnabled(projectPath: string, on: boolean): void {
  if (!boundUserDataDir) {
    throw new Error('orchestration consent store not bound (call bindConsentStore at boot)')
  }
  writeDecision(boundUserDataDir, projectPath, on ? 'enabled' : 'declined')
}

/**
 * Register orchestration:getConsent / orchestration:setConsent IPC handlers (frame-guarded).
 * Binds the seam store to `userDataDir` as a side effect — one wire-up call at boot.
 *
 * @param ipcMain       Electron's ipcMain (or a fake in tests).
 * @param getWin        Returns the trusted BrowserWindow (foreign-sender guard).
 * @param userDataDir   Explicit userData path; never read from `app` so it stays testable.
 * @param getCurrentDir Returns the currently open project directory, or null when none.
 * @param onChange      Called AFTER a decision is persisted — the P3 hook installs (on
 *                      'enabled') / removes (on 'declined') the per-CLI provisioner configs.
 *                      Best-effort: the handler returns ok once the decision is durable
 *                      regardless of onChange's outcome (it must own its own errors —
 *                      fire-and-forget any async work, never throw synchronously).
 */
export function registerOrchestrationHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  getCurrentDir: () => string | null,
  onChange: (projectPath: string, on: boolean) => void
): void {
  bindConsentStore(userDataDir)
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('orchestration:getConsent', (e): OrchestrationConsentState => {
    if (guard(e)) return 'declined'
    const dir = getCurrentDir()
    if (!dir) return 'declined'
    return readDecision(userDataDir, dir) ?? 'undecided'
  })

  ipcMain.handle('orchestration:setConsent', (e, decision: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const dir = getCurrentDir()
    if (!dir || (decision !== 'enabled' && decision !== 'declined')) return { ok: false }
    writeDecision(userDataDir, dir, decision)
    onChange(dir, decision === 'enabled') // install / remove the P3 provisioner configs
    return { ok: true }
  })
}

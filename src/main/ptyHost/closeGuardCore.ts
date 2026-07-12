/**
 * Close-guard decision core, pure (the quitDrain.ts pattern: bridge/closeGuard import electron,
 * so the semantics live here where the unit suite can reach them). Decides what a window-close
 * attempt does BEFORE the quit path latches (DESIGN.md D5 — PR-2):
 *
 * - 'proceed' — today's close: window closes → app quits → kill-everything drain. Taken when
 *   the quit path already owns the close (update install / tray quit / a guard-approved
 *   re-close), when nothing would survive a keep (no daemon-backed sessions — offering "keep
 *   running" would be a lie), or when the setting says always-stop.
 * - 'keep' — the setting says always-keep: silent tray residency, no modal.
 * - 'ask'  — pop the close modal and let the user choose.
 */
import type { CloseGuardAnswer } from '../../shared/closeGuardTypes'
import type { CloseWithSessions } from './config'

export type CloseDecision = 'proceed' | 'keep' | 'ask'

export interface CloseDecisionInput {
  /** before-quit already latched — the quit path owns this close (update install, tray quit,
   *  crash sinks). The guard must NEVER re-prompt here (locked: update restart never prompts). */
  quitting: boolean
  /** A guard-approved "stop" answer is re-driving win.close() — let it through. */
  bypass: boolean
  /** Already tray-resident (our own window teardown) — nothing to guard. */
  resident: boolean
  /** Daemon-backed sessions that would genuinely survive a keep (bridge.listKeepableSessions). */
  keepableCount: number
  /** Settings › Terminal › "When closing with running sessions". */
  mode: CloseWithSessions
}

export function decideOnClose(d: CloseDecisionInput): CloseDecision {
  if (d.quitting || d.bypass || d.resident) return 'proceed'
  if (d.keepableCount === 0) return 'proceed'
  if (d.mode === 'stop') return 'proceed'
  if (d.mode === 'keep') return 'keep'
  return 'ask'
}

/**
 * Normalize the renderer's modal reply, fail-SAFE: anything malformed (garbage object, foreign
 * shape, missing action) collapses to `cancel` — a bad reply must neither kill sessions nor
 * silently background the app; it changes nothing and the window stays open. (Contrast
 * mcpConfirm's fail-closed DENY: here every non-cancel outcome is destructive or surprising,
 * so "do nothing" is the safe floor.)
 */
export function normalizeCloseAnswer(reply: unknown): CloseGuardAnswer {
  const r = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {}
  const action = r.action === 'keep' || r.action === 'stop' ? r.action : 'cancel'
  return { action, remember: r.remember === true }
}

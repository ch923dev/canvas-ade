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
import type { CloseGuardAnswer, CloseSessionRow } from '../../shared/closeGuardTypes'
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

/** The session-map slices the keepable snapshot reads (bridge.ts's real maps satisfy them). */
export interface KeepableSessionLike {
  proc: unknown
  state?: string
  lastActivityAt?: number
  awaitingInput?: boolean
}
export interface KeepableParkedLike {
  proc: unknown
  kind?: string
}
export interface KeepableFacts {
  launchCommand?: string
  shell: string
  startedAt: number
}

export interface KeepableSnapshotDeps {
  sessions: ReadonlyMap<string, KeepableSessionLike>
  parked: ReadonlyMap<string, KeepableParkedLike>
  boardCwds: ReadonlyMap<string, string>
  facts: ReadonlyMap<string, KeepableFacts>
  isDaemonProxy: (proc: unknown) => boolean
  getTitle: (id: string) => string | undefined
}

/** Display command for a session: its launchCommand (what the user is actually running),
 *  else the shell binary name — the mock-1 "cmd" column ("pwsh", not a path), honest either
 *  way. Manual separator split (NOT node:path.basename): the shell string is a WINDOWS path
 *  whatever platform this pure core runs on — POSIX basename would return the whole
 *  backslashed string (the CI-linux unit-suite lesson), and the tray core already renders
 *  rows this way, so modal and tray stay consistent. */
function displayCmd(facts: KeepableFacts | undefined): string {
  const launch = facts?.launchCommand?.trim()
  if (launch) return launch
  if (!facts) return 'shell'
  const base = facts.shell.replace(/\\/g, '/').split('/').pop() ?? facts.shell
  return base.replace(/\.exe$/i, '')
}

/**
 * The close-modal snapshot filter, pure (review #340 [warning] — this decides which sessions
 * the modal PROMISES will survive a keep, so its exclusions are unit-tested like the sibling
 * cores): every session that would genuinely survive — live daemon-backed sessions plus
 * daemon-backed background parks (their procs run headless). In-proc fallback sessions (D2)
 * are deliberately excluded (they die with this process — listing them under "keep running"
 * would be a lie), as are non-'running' live entries and undo parks (deleted boards).
 */
export function buildKeepableRows(d: KeepableSnapshotDeps): CloseSessionRow[] {
  const rows: CloseSessionRow[] = []
  for (const [id, s] of d.sessions) {
    if (!d.isDaemonProxy(s.proc)) continue
    if (s.state && s.state !== 'running') continue
    const facts = d.facts.get(id)
    rows.push({
      id,
      cmd: displayCmd(facts),
      title: d.getTitle(id) ?? null,
      cwd: d.boardCwds.get(id) ?? null,
      // Honest dot: only the idle-at-prompt heuristic dims a row (absent = running).
      running: s.awaitingInput !== true,
      startedAt: facts?.startedAt ?? 0,
      lastActivityAt: s.lastActivityAt ?? 0
    })
  }
  for (const [id, p] of d.parked) {
    // Background parks only — an undo park is a deleted board, not a running terminal.
    if (p.kind !== 'background' || !d.isDaemonProxy(p.proc)) continue
    const facts = d.facts.get(id)
    rows.push({
      id,
      cmd: displayCmd(facts),
      title: d.getTitle(id) ?? null,
      cwd: d.boardCwds.get(id) ?? null,
      running: true, // parked-background procs run headless; no idle tracking exists for them
      startedAt: facts?.startedAt ?? 0,
      lastActivityAt: 0
    })
  }
  return rows
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

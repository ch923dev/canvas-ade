/**
 * Close-guard wire types (PR-2 background sessions): the session rows MAIN snapshots for the
 * close modal, and the modal's answer. Shared main ⇄ preload ⇄ renderer so the three can't
 * drift (the mcpTypes precedent). Raw epochs travel; display formatting is the renderer's
 * (`formatSessionAge`, kept here so the tray menu builder in MAIN renders identical labels).
 */

export interface CloseSessionRow {
  /** Board id (the session key). */
  id: string
  /** Honest display command — the board's launchCommand, else the shell binary name. */
  cmd: string
  /** Board title when known (active project's registry mirror), else null. */
  title: string | null
  /** Resolved spawn cwd (the locator line), else null. */
  cwd: string | null
  /** Honest dot: false = the idle-at-prompt heuristic flagged this session (dimmed row). */
  running: boolean
  /** Epoch ms of spawn — drives "running 24m". 0 = unknown (PR-1-era survivor). */
  startedAt: number
  /** Epoch ms of last PTY output — drives "idle 41m". 0 = unknown. */
  lastActivityAt: number
}

/** The modal's answer. Anything malformed collapses to 'cancel' in MAIN (fail-safe: a
 *  garbage reply must never kill sessions NOR silently keep them — it changes nothing). */
export interface CloseGuardAnswer {
  action: 'keep' | 'stop' | 'cancel'
  /** "Always do this" — persists the chosen action to Settings › Terminal. */
  remember: boolean
}

/** What MAIN pushes to the renderer to open the modal. */
export interface CloseGuardQuery {
  sessions: CloseSessionRow[]
  replyChannel: string
}

/** "running 24m" / "idle 41m" style relative age. Sub-minute reads "now" (a dot that just
 *  flipped shouldn't claim a zero-minute age). Shared by the modal rows and the tray menu. */
export function formatSessionAge(nowMs: number, sinceMs: number): string {
  if (!sinceMs || sinceMs > nowMs) return ''
  const mins = Math.floor((nowMs - sinceMs) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

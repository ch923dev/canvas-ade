/**
 * Tray-residency state math, pure (the quitDrain/closeGuardCore pattern — trayResidency.ts
 * imports electron, so everything a unit test needs lives here). Models the poll loop's
 * decisions: which sessions exited since the last poll, what the menu shows, and when
 * residency ends (zero sessions → the app must fully quit — no permanent resident).
 */
import { formatSessionAge, type CloseSessionRow } from '../../shared/closeGuardTypes'
import type { SessionInfo } from './protocol'

/** One rendered tray-menu session row (mock 2: "claude · API server · 24m"). */
export interface TrayMenuRow {
  id: string
  label: string
}

export interface TrayMenuModel {
  /** Header line, e.g. "Expanse — 2 sessions running". */
  header: string
  rows: TrayMenuRow[]
}

/** Ids present in `prev` but gone from `next` — sessions that exited between polls. */
export function exitedIds(prev: readonly string[], next: readonly string[]): string[] {
  const alive = new Set(next)
  return prev.filter((id) => !alive.has(id))
}

/** Display command for a daemon session row: launchCommand, else the shell binary name. */
function cmdOf(info: SessionInfo): string {
  const launch = info.meta.launchCommand?.trim()
  if (launch) return launch
  const shell = info.meta.shell
  const base = shell.replace(/\\/g, '/').split('/').pop() ?? shell
  return base.replace(/\.exe$/i, '')
}

/** Locator for a row: last path segment of the spawn cwd (the daemon list has no board titles). */
function whereOf(info: SessionInfo): string {
  const cwd = info.meta.cwd
  if (!cwd) return ''
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
}

/**
 * Build the tray menu's session model from a daemon list. Rows are honest: named by what the
 * user launched, located by cwd, aged from the round-tripped spawn epoch (blank for a
 * PR-1-era survivor with no `startedAt`). Sorted stable by id so the menu doesn't shuffle
 * between polls.
 */
export function buildTrayMenuModel(list: readonly SessionInfo[], nowMs: number): TrayMenuModel {
  const n = list.length
  const rows = [...list]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((info) => {
      const age = info.meta.startedAt ? formatSessionAge(nowMs, info.meta.startedAt) : ''
      const where = whereOf(info)
      const parts = [cmdOf(info), where, age ? `running ${age}` : ''].filter(Boolean)
      return { id: info.id, label: parts.join(' · ') }
    })
  return {
    header: `Expanse — ${n} session${n === 1 ? '' : 's'} running`,
    rows
  }
}

/** Seed menu model from the close-modal snapshot (shown until the first poll lands). */
export function seedModelFromRows(rows: readonly CloseSessionRow[], nowMs: number): TrayMenuModel {
  const n = rows.length
  return {
    header: `Expanse — ${n} session${n === 1 ? '' : 's'} running`,
    rows: [...rows]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const age = r.startedAt ? formatSessionAge(nowMs, r.startedAt) : ''
        const where = r.title ?? (r.cwd?.replace(/\\/g, '/').split('/').pop() || '')
        const parts = [r.cmd, where, age ? `running ${age}` : ''].filter(Boolean)
        return { id: r.id, label: parts.join(' · ') }
      })
  }
}

/**
 * Cross-cwd recap capture — runtime claude-boot detection (the hand-typed-`claude` seam).
 *
 * The spawn-time hook install covers the board's spawn cwd, but a user can `cd` anywhere in the
 * shell and hand-type `claude` — that session's project dir is the shell's cwd AT LAUNCH, which
 * MAIN cannot know ahead of time. What it CAN do is read it back: the claude boot banner prints
 * the session's working directory right under the version line. On any output chunk containing
 * the banner marker, parse the ring for that path and ensure the recap hook there (idempotent,
 * no-op-write-guarded — same syncRecapHook seam the spawn path uses).
 *
 * Timing honesty: hooks are (re)read by the claude process per event, so an install that lands
 * after session start still captures from the next UserPromptSubmit onward (the confirmed-capture
 * path). Worst case (a claude build that snapshots hooks at boot) the install primes the dir for
 * the NEXT run — either way the dir converges to captured.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import { syncRecapHook } from './ptySpawnEnv'

/** The stable prefix of the claude boot banner's version line. */
const BANNER = 'Claude Code v'
/** How many lines below the banner to scan for the printed working directory. */
const SCAN_LINES = 8

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** An absolute path on either platform (C:\… / \\server\… / /home/…). */
function looksAbsolute(line: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(line)
}

/**
 * Pure-ish parse (fs.statSync guard only): find the LAST boot banner in the ring — the current
 * boot, not a scrollback ghost — and return the first existing directory printed in the lines
 * beneath it. Null when no banner / no directory line.
 */
export function detectClaudeBootCwd(ring: string): string | null {
  const clean = ring.replace(ANSI, '')
  const at = clean.lastIndexOf(BANNER)
  if (at === -1) return null
  const lines = clean
    .slice(at)
    .split(/\r?\n/)
    .slice(1, 1 + SCAN_LINES)
  for (const raw of lines) {
    const line = raw.trim()
    if (!looksAbsolute(line)) continue
    try {
      if (fs.statSync(line).isDirectory()) return line
    } catch {
      /* not a real dir — keep scanning */
    }
  }
  return null
}

/**
 * The one-line pty.ts data-plane hook: cheap substring test per chunk; only a chunk carrying
 * the banner marker pays the ring parse. The home dir is skipped for the same reason as the
 * spawn-time policy (Claude Code USER scope). Never throws — data handling must never break.
 */
export function maybeEnsureClaudeHook(chunk: string, ringText: () => string, id: string): void {
  try {
    if (!chunk.includes(BANNER)) return
    const cwd = detectClaudeBootCwd(ringText())
    if (cwd && cwd !== os.homedir()) syncRecapHook({ id, cwd })
  } catch {
    /* best-effort — never break the data plane */
  }
}

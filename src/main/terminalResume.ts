/**
 * Terminal Resume validation + click-time resolution (terminal-resume research, layers F1+F3 —
 * docs/research/2026-07-03-terminal-resume-capture/REPORT.md).
 *
 * The recap hook captures `agentSessionId` EAGERLY at Claude's SessionStart, before the
 * `<id>.jsonl` transcript exists, and the id then persists in canvas.json forever — so a bare
 * `!!board.agentSessionId` gate offered Resume for sessions that were never resumable
 * (launch-then-quit, mid-session rotation, 30-day transcript retention), and the click ran
 * `claude --resume <id>` straight into `No conversation found with session ID: <id>`.
 *
 * Two frame-guarded channels, both answering from the transcript's CURRENT on-disk reality:
 *  - `terminal:resumeCheck`  (F1) → is the stored session actually resumable RIGHT NOW?
 *  - `terminal:resumeLaunch` (F3) → the launch line to run at Resume-click time, re-resolved
 *    fresh so a check-to-click race (file pruned/rotated in between) degrades to `--continue`
 *    or a fresh start instead of a dead `--resume`.
 *
 * SECURITY: `sessionId`/`transcriptPath` arrive from the renderer but ORIGINATE in canvas.json,
 * which a shared/third-party project file can craft — treat both as untrusted. The id is
 * charset-stripped here in MAIN (the boundary the launch line is built behind) before it nears
 * a command string, and the path must pass isTrustedTranscriptPath before any read.
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { isForeignSender } from './ipcGuard'
import { safeBoardId } from './canvasMemory'
import { isTrustedTranscriptPath, readTranscriptTail } from './agentTranscript'
import type { RecapMapEntry } from './agentRecapMap'

/** The board's stored session fields as the renderer knows them (canvas.json → UNTRUSTED). */
export interface StoredSession {
  sessionId?: unknown
  transcriptPath?: unknown
}

/**
 * How a Resume request resolves against the transcript's on-disk reality:
 *  - `resume`: a lineage-proven transcript exists — `sessionId` is the id to resume, which is
 *    the ACTUAL id of the transcript's newest turns (`adopted` when rotation moved the session
 *    past the recorded id, `recorded` when they match).
 *  - `continue`: the resolved transcript is not provably this session's lineage, but no OTHER
 *    board claims it either — `claude --continue` (the cwd's most recent session) is the best
 *    recovery on offer.
 *  - `fresh`: nothing resumable — start clean (the reason says why, for diagnostics/tests).
 */
export type ResumeResolution =
  | { kind: 'resume'; sessionId: string; source: 'recorded' | 'adopted' }
  | { kind: 'continue' }
  | {
      kind: 'fresh'
      reason: 'no-session' | 'no-transcript' | 'empty-transcript' | 'foreign-transcript'
    }

/** What both IPC channels return to the renderer. `command` is absent on `fresh`. */
export interface ResumeLaunch {
  mode: 'resume' | 'continue' | 'fresh'
  command?: string
}

/**
 * Strip everything outside a Claude session id's charset (UUID: alphanumeric + `-`/`_`) so no
 * shell metacharacter or whitespace survives as its own token — the exact rule the retired
 * renderer-side resumeCommand.ts enforced, now living in MAIN where the line is built.
 */
export function sanitizeSessionId(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[^a-zA-Z0-9_-]/g, '') : ''
}

/**
 * A session id shorter than this is too weak to anchor a lineage `includes` check (a 1-char
 * "id" would substring-match ANY transcript) — same floor findLineageSuccessor uses.
 */
const MIN_LINEAGE_ID_LEN = 8

/**
 * The ACTUAL session id the transcript currently belongs to: the newest parseable line's
 * `sessionId` field (every Claude transcript line carries the CURRENT session's id, so after a
 * compaction/`/resume` rotation the newest lines carry the successor's id while copied history
 * retains the original's — which is what lineage matching keys on). A tail read can start
 * mid-line; that partial first line is malformed JSON and gets skipped. Never throws.
 */
export function extractSessionIdFromTail(jsonl: string): string | undefined {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s) as { sessionId?: unknown }
      if (typeof rec.sessionId === 'string' && rec.sessionId) return rec.sessionId
    } catch {
      continue // malformed/partial line — keep walking up
    }
  }
  return undefined
}

export interface ResumeDeps {
  getWin: () => BrowserWindow | null
  /**
   * The A4 transcript resolver (the index.ts closure every recap read path shares): recorded
   * path → the LIVE path, with the eager-capture grace + lineage-proven rotation adoption.
   */
  resolveTranscript: (boardId: string, recorded: string | undefined) => string | undefined
  /** The live recap map — this board's fallback recorded path + the sibling-claim guard. */
  getMapEntries: () => ReadonlyMap<string, RecapMapEntry>
  /** Injected for tests; default process.env. */
  env?: NodeJS.ProcessEnv
}

/** One resolution attempt for a concrete {sessionId, transcriptPath} candidate. */
function resolveAttempt(
  deps: ResumeDeps,
  boardId: string,
  sid: string,
  recorded: string | undefined,
  env: NodeJS.ProcessEnv
): ResumeResolution {
  const resolved = deps.resolveTranscript(boardId, recorded)
  if (!resolved || !isTrustedTranscriptPath(resolved, env) || !existsSync(resolved)) {
    return { kind: 'fresh', reason: 'no-transcript' }
  }

  let tail = ''
  try {
    tail = readTranscriptTail(resolved)
  } catch {
    return { kind: 'fresh', reason: 'no-transcript' } // vanished between existsSync and read
  }
  if (!tail.trim()) return { kind: 'fresh', reason: 'empty-transcript' }

  if (tail.includes(sid)) {
    // Lineage-proven: this transcript IS (a successor of) the stored session. Resume the id its
    // newest turns actually carry — after a rotation that differs from the stored one, and
    // resuming the stored id would be the exact "No conversation found" the stored id earns.
    const actual = sanitizeSessionId(extractSessionIdFromTail(tail))
    const sessionId = actual.length >= MIN_LINEAGE_ID_LEN ? actual : sid
    return { kind: 'resume', sessionId, source: sessionId === sid ? 'recorded' : 'adopted' }
  }

  // Foreign lineage: the resolved transcript never saw this session id. If ANOTHER board's map
  // entry claims that file, `--continue` (cwd's most recent session) would reattach THIS board
  // to THAT board's conversation — the sibling-reattribution bug (BUG-005's Resume-shaped
  // twin) — so start fresh instead. Unclaimed, `--continue` is an acceptable best-effort
  // (e.g. the lineage anchor fell outside the 64KB tail window of a long successor).
  for (const [otherId, other] of deps.getMapEntries()) {
    if (otherId !== boardId && other.transcriptPath === resolved) {
      return { kind: 'fresh', reason: 'foreign-transcript' }
    }
  }
  return { kind: 'continue' }
}

/**
 * Resolve what Resume should actually do for a board, from the transcript's on-disk reality —
 * never from the stored id alone. Synchronous + total (never throws); IO is bounded 64KB
 * tail reads behind the trusted-path guard.
 *
 * Two candidates, in order:
 * 1. the STORED session (board doc fields, falling back to the map's latest entry's path);
 * 2. F2: the map's CONFIRMED capture — the latest hook line that saw the transcript on disk.
 *    This is what rescues the original bug's worst shape: the stored id is a dead eager capture
 *    (launch-then-quit), but the board HAD a real conversation before it — Resume reattaches
 *    that one instead of being withheld entirely.
 * A `resume` from either wins; otherwise the stored candidate's continue/fresh verdict stands
 * (the confirmed capture never downgrades a `continue` to `fresh`).
 */
export function resolveResume(
  deps: ResumeDeps,
  boardId: string,
  stored: StoredSession
): ResumeResolution {
  const env = deps.env ?? process.env
  const entry = deps.getMapEntries().get(boardId)

  const sid = sanitizeSessionId(stored.sessionId)
  let primary: ResumeResolution = { kind: 'fresh', reason: 'no-session' }
  if (sid.length >= MIN_LINEAGE_ID_LEN) {
    const recorded =
      typeof stored.transcriptPath === 'string' && stored.transcriptPath
        ? stored.transcriptPath
        : entry?.transcriptPath
    primary = resolveAttempt(deps, boardId, sid, recorded, env)
    if (primary.kind === 'resume') return primary
  }

  const conf = entry?.confirmed
  const confSid = sanitizeSessionId(conf?.sessionId)
  if (
    conf &&
    confSid.length >= MIN_LINEAGE_ID_LEN &&
    // Skip a no-op retry of the identical candidate the primary attempt already rejected.
    (confSid !== sid || conf.transcriptPath !== stored.transcriptPath)
  ) {
    const secondary = resolveAttempt(deps, boardId, confSid, conf.transcriptPath, env)
    if (secondary.kind === 'resume') return secondary
  }
  return primary
}

/** The PTY launch line for a resolution — built ONLY from sanitized parts. */
export function resumeLaunchLine(r: ResumeResolution): ResumeLaunch {
  if (r.kind === 'resume') return { mode: 'resume', command: `claude --resume ${r.sessionId}` }
  if (r.kind === 'continue') return { mode: 'continue', command: 'claude --continue' }
  return { mode: 'fresh' }
}

export function registerTerminalResumeIpc(ipcMain: IpcMain, deps: ResumeDeps): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, deps.getWin)
  const resolve = (e: IpcMainInvokeEvent, boardId: unknown, stored: unknown): ResumeResolution => {
    if (guard(e)) return { kind: 'fresh', reason: 'no-session' }
    // BUG-032 discipline: enforce safeBoardId at IPC ingress before any work.
    if (typeof boardId !== 'string' || !safeBoardId(boardId)) {
      return { kind: 'fresh', reason: 'no-session' }
    }
    const s = stored && typeof stored === 'object' ? (stored as StoredSession) : {}
    return resolveResume(deps, boardId, s)
  }
  // F1: the canResume gate. Sync by design — one bounded tail pread, same weight class as
  // recap:get (which reads the identical tail on every recap-face open).
  ipcMain.handle('terminal:resumeCheck', (e, boardId: unknown, stored: unknown) => {
    return { canResume: resolve(e, boardId, stored).kind === 'resume' }
  })
  // F3: the click-time launch line, re-resolved fresh (never trusts a prior check).
  ipcMain.handle('terminal:resumeLaunch', (e, boardId: unknown, stored: unknown): ResumeLaunch => {
    return resumeLaunchLine(resolve(e, boardId, stored))
  })
}

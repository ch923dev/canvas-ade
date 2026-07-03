import {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
  existsSync
} from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep, dirname, join } from 'node:path'
import { redactSecrets } from './summaryLoop'

export interface Milestone {
  ts: number
  role: 'user' | 'agent'
  text: string
}
export interface ExtractOpts {
  maxMilestones?: number
  maxTextChars?: number
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: unknown })?.type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

/** Parse a Claude transcript JSONL into meaningful milestones (user + assistant text only). */
export function extractMilestones(jsonl: string, opts: ExtractOpts = {}): Milestone[] {
  const maxN = opts.maxMilestones ?? 12
  const cap = opts.maxTextChars ?? 600
  const out: Milestone[] = []
  for (const raw of jsonl.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let rec: {
      type?: unknown
      timestamp?: unknown
      message?: { role?: unknown; content?: unknown }
    }
    try {
      rec = JSON.parse(s)
    } catch {
      continue // skip malformed lines (incl. a partial first line from a tail read)
    }
    const role = rec.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    // BUG-011: redact secrets on the FULL turn text BEFORE the length cap. redactSecrets' patterns
    // are length-gated (hex/base64 >= 40 chars; sk-/gh*/Bearer >= 16-20), so a secret straddling the
    // `cap` offset would have only a sub-threshold prefix survive the slice and egress unredacted.
    // Redacting first collapses the full-length match to the short [redacted] token before the cap.
    // buildRecapInput still re-redacts (belt-and-suspenders) — this just closes the truncation gap.
    const text = redactSecrets(textFromContent(rec.message?.content).trim())
    if (!text) continue // assistant tool-only turns have no text -> dropped
    const ts = Date.parse(String(rec.timestamp ?? '')) || 0
    out.push({ ts, role: role === 'user' ? 'user' : 'agent', text: text.slice(0, cap) })
  }
  return out.slice(-maxN)
}

/** Default tail window — recaps only need the recent turns, not megabytes of history. */
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024

/**
 * Read only the last `maxBytes` of a (possibly large) transcript rather than the whole file:
 * extractMilestones keeps just the last N turns, so reading the head is wasted work + a
 * main-thread stall on a long session. A tail read can start mid-line; that leading partial
 * line is malformed JSON and extractMilestones drops it (per-line try/catch), so the milestones
 * are unaffected. Synchronous by design — the summary loop that calls this is already debounced.
 */
export function readTranscriptTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = size > maxBytes ? size - maxBytes : 0
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    // BUG-034: honor the actual byte count returned by readSync. If the file shrinks between
    // fstatSync and readSync (TOCTOU: an external process truncates/replaces the transcript),
    // readSync returns fewer bytes and the tail of the allocUnsafe buffer is uninitialized
    // prior heap content. Slicing to bytesRead ensures only real file bytes are decoded, so
    // no heap content (which may include decrypted API keys or prior transcript data) can
    // appear in the string handed to extractMilestones -> buildRecapInput -> LLM egress.
    const bytesRead = readSync(fd, buf, 0, len, start)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

/** Root where Claude Code writes session transcripts (CLAUDE_CONFIG_DIR overrides ~/.claude). */
function claudeConfigRoot(env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR
  return override && override.length > 0 ? resolve(override) : resolve(homedir(), '.claude')
}

/**
 * Guard a transcript path before MAIN reads + (secret-scrubbed) egresses it. The path is
 * persisted in canvas.json, so a hand-crafted project file could otherwise point it at an
 * arbitrary file whose scrubbed contents would be sent to the user's LLM — violating the
 * consent modal's "nothing else leaves" promise. Require a `.jsonl` file resolving under the
 * Claude config root (where Claude's own SessionStart hook legitimately writes transcripts).
 * `resolve` collapses any `..` before the prefix check, so traversal can't escape the root.
 */
export function isTrustedTranscriptPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (typeof path !== 'string' || !path.toLowerCase().endsWith('.jsonl')) return false
  const root = claudeConfigRoot(env)
  const abs = resolve(path)
  return abs === root || abs.startsWith(root + sep)
}

/**
 * Resolve the CURRENT live transcript for a board from a (possibly stale) recorded path.
 *
 * The recap bridge learns a transcript path at Claude SessionStart, but an auto-COMPACTION or a
 * `/resume` can roll the agent onto a NEW transcript file mid-session WITHOUT firing SessionStart
 * — stranding the recap on a dead file, so it shows a long-gone session (the dunly-dunning case:
 * recorded `5e985fe0.jsonl` no longer existed while the live session wrote `b22cb76e.jsonl`).
 * Claude always writes the live session as the newest `.jsonl` in its per-cwd project dir, so we
 * resolve to the newest-mtime `.jsonl` in the recorded path's DIRECTORY. This self-heals a stale
 * recorded path (even one whose file is gone — only its dir is needed).
 *
 * Trusted-path-guarded: only scans when the recorded path is trusted (a `.jsonl` under the Claude
 * config root), and every candidate is a `.jsonl` in that SAME dir, so the result is still trusted
 * (the caller re-validates with isTrustedTranscriptPath either way). Falls back to the recorded
 * path when the dir can't be scanned or holds no `.jsonl`. Synchronous + total (never throws).
 *
 * BUG-005: the directory-wide newest-mtime scan is ONLY a rotation self-heal — it must not run
 * when the recorded file itself is still present. Claude lays out every session started in the
 * same cwd into the SAME directory, so two Terminal boards sharing a cwd (the common default —
 * see TerminalBoard's "no explicit cwd spawns in the project folder") each have their own
 * recorded path living side-by-side. If the scan ran unconditionally, a board that merely went
 * idle (its own `.jsonl` still exists, just isn't the newest) would get silently reattributed to
 * whichever sibling board's session is actively writing. Only a GENUINE rotation (compaction /
 * `/resume` rolling onto a new file, which removes or replaces the recorded one) should trigger
 * the scan — signaled here by the recorded path no longer existing.
 *
 * Recap-refresh fix A4 adds two clock-guarded branches (everything below up to the function
 * is that cluster): an EAGER-CAPTURE grace (fresh map entry + still-missing file resolves to
 * undefined -- never scan onto an OLDER session) and lineage-proven ROTATION adoption for the
 * roll-while-the-old-file-survives case the missing-file signal can't see.
 */
/** Options for resolveLiveTranscriptPath (recap-refresh fix A4). All optional + additive. */
export interface ResolveOpts {
  env?: NodeJS.ProcessEnv
  /** The recorded session id (recap map) -- the lineage anchor for rotation detection. */
  sessionId?: string
  /** When the SessionStart hook recorded the entry (epoch ms) -- the eager-capture clock. */
  recordedAt?: number
  /** The board's live PTY last-activity clock (epoch ms) -- the rotation-suspicion signal. */
  agentActiveAt?: number
  /** Injected for deterministic tests; default Date.now(). */
  now?: number
}

/**
 * Eager-capture grace: the SessionStart hook records the transcript path BEFORE Claude has
 * written the `.jsonl` (it only lands once the conversation has real content). Inside this
 * window a missing recorded file means "session too young", NOT "rotated away" -- and the
 * newest EXISTING `.jsonl` in the dir is by definition an OLDER session, so scanning would
 * present the previous session's recap as current (the "describes an earlier session" bug).
 */
export const EAGER_CAPTURE_GRACE_MS = 60_000

/** The agent counts as actively producing when its PTY saw data within this window. */
const ROTATION_ACTIVE_MS = 60_000

/**
 * Rotation suspicion threshold: the agent's PTY is demonstrably active but the recorded
 * transcript stopped receiving writes this much earlier than the activity clock -- the
 * signature of compaction/`/resume` rolling onto a NEW file without firing SessionStart.
 */
export const ROTATION_LAG_MS = 120_000

/** How many newer sibling transcripts get a lineage tail-read before giving up (bounded IO). */
const MAX_LINEAGE_CANDIDATES = 5

/**
 * Find the rotation successor of `recordedPath`: a `.jsonl` in the SAME dir, newer than the
 * recorded file's mtime, whose bounded tail CONTAINS the recorded session id -- the lineage a
 * compacted/resumed successor carries via its copied history. The lineage requirement is what
 * preserves BUG-005: a sibling board's unrelated live session never references this session's
 * id, so it can never be adopted. Newest-first, capped tail reads. Never throws.
 */
function findLineageSuccessor(
  recordedPath: string,
  recordedMtime: number,
  sessionId: string
): string | undefined {
  try {
    const dir = dirname(recordedPath)
    const candidates: { path: string; mtime: number }[] = []
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const p = join(dir, name)
      if (p === recordedPath) continue
      let mtime: number
      try {
        mtime = statSync(p).mtimeMs
      } catch {
        continue // vanished between readdir and stat
      }
      if (mtime > recordedMtime) candidates.push({ path: p, mtime })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    for (const c of candidates.slice(0, MAX_LINEAGE_CANDIDATES)) {
      try {
        if (readTranscriptTail(c.path).includes(sessionId)) return c.path
      } catch {
        continue // unreadable candidate -- try the next
      }
    }
  } catch {
    /* unreadable dir -- no successor */
  }
  return undefined
}

export function resolveLiveTranscriptPath(
  recordedPath: string | undefined,
  opts: ResolveOpts = {}
): string | undefined {
  const env = opts.env ?? process.env
  if (!recordedPath || !isTrustedTranscriptPath(recordedPath, env)) return recordedPath
  const now = opts.now ?? Date.now()
  let recordedExists = false
  try {
    recordedExists = existsSync(recordedPath)
  } catch {
    recordedExists = false // treat as vanished — fall through to the missing-file branches
  }

  if (recordedExists) {
    // Recap-refresh fix A4: rotation-WHILE-recorded-exists. Compaction/`/resume` can roll the
    // agent onto a new transcript while the OLD file survives on disk — the recorded-file-gone
    // signal below never fires, stranding the recap. Detect it by clocks (PTY active, recorded
    // mtime stale) and adopt only a LINEAGE-PROVEN successor (tail contains our session id) —
    // an active sibling board's unrelated session can never match (BUG-005 stays fixed).
    // A session id shorter than 8 chars is too weak an anchor to trust as lineage.
    if (
      opts.sessionId &&
      opts.sessionId.length >= 8 &&
      typeof opts.agentActiveAt === 'number' &&
      now - opts.agentActiveAt < ROTATION_ACTIVE_MS
    ) {
      try {
        const recordedMtime = statSync(recordedPath).mtimeMs
        if (opts.agentActiveAt - recordedMtime > ROTATION_LAG_MS) {
          const successor = findLineageSuccessor(recordedPath, recordedMtime, opts.sessionId)
          if (successor) return successor
        }
      } catch {
        /* stat failed — keep the recorded path */
      }
    }
    return recordedPath
  }

  // Recap-refresh fix A4: eager-capture grace. A FRESH map entry whose file is still missing
  // means Claude has not written the transcript yet — return undefined (facts degrade to
  // runtime-only; the recap watcher's dir-watch fallback re-arms when the real file lands)
  // instead of scanning, which would resolve to an OLDER session's file.
  if (typeof opts.recordedAt === 'number' && now - opts.recordedAt < EAGER_CAPTURE_GRACE_MS) {
    return undefined
  }

  try {
    const dir = dirname(recordedPath)
    let newest: { path: string; mtime: number } | undefined
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const p = join(dir, name)
      let mtime: number
      try {
        mtime = statSync(p).mtimeMs
      } catch {
        continue // vanished between readdir and stat
      }
      if (!newest || mtime > newest.mtime) newest = { path: p, mtime }
    }
    return newest?.path ?? recordedPath
  } catch {
    return recordedPath // unreadable dir → recorded path (downstream existsSync still guards)
  }
}

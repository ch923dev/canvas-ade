import { openSync, fstatSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
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
 */
export function resolveLiveTranscriptPath(
  recordedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!recordedPath || !isTrustedTranscriptPath(recordedPath, env)) return recordedPath
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

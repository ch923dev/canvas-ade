import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

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
    const text = textFromContent(rec.message?.content).trim()
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

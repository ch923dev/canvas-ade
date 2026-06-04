import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 🔒 Append-only audit trail for MCP dispatch (M4). EVERY action that writes into
 * another board's shell — handoff_prompt / assign_prompt / interrupt / relay_prompt
 * (T4.3–T4.6) — records an entry here BEFORE/AFTER it runs: the resolved target board id, the full
 * prompt, the single-use nonce + monotonic sequence, the outcome, and a timestamp.
 * The log is the forensic record that a tainted/worker-originated prompt can trigger
 * nothing without leaving a trace + passing the human gate.
 *
 * Persisted as JSONL under `app.getPath('userData')` (NEVER the project folder — an
 * audit trail must outlive any one project and never be synced/committed). Append-only
 * via `appendFile` (NOT write-file-atomic — that rewrites the whole file, which defeats
 * an unbounded append log and races a concurrent reader). MAIN is the single writer.
 */

export interface AuditInput {
  /** The dispatch tool that produced this entry (e.g. 'handoff_prompt', 'interrupt'). */
  type: string
  /** The RESOLVED opaque server board id the action targeted (never a user label). */
  targetId: string
  /** The full prompt text written to the target PTY ('' for a content-less action). */
  prompt: string
  /** The single-use nonce that authorized this dispatch (T4.3). */
  nonce: string
  /** Outcome bucket; defaults to 'dispatched' when the entry is recorded pre-result. */
  status?: string
  /** Captured output / result text, when the action produced one. */
  outputs?: string
  /** Free-form extra context (e.g. a rejection reason). */
  detail?: string
}

export interface AuditEntry {
  /** Monotonic, gap-free sequence across the life of the log (replay/order evidence). */
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
  outputs?: string
  detail?: string
}

export interface AuditLog {
  /** Shape + stamp + persist one entry; resolves to the written entry. */
  append(input: AuditInput): Promise<AuditEntry>
  /** Most-recent-first, capped to `limit` (default 200); [] when the log is absent. */
  read(opts?: { limit?: number }): Promise<AuditEntry[]>
}

/** Short identifier-ish fields (type/target/nonce/status). */
const MAX_SHORT = 256
/** Long free-text fields (prompt/outputs/detail) — generous, but not unbounded. */
const MAX_LONG = 100_000
const DEFAULT_READ_LIMIT = 200
const AUDIT_FILE = 'mcp-audit.jsonl'

const cap = (v: unknown, max: number): string => String(v ?? '').slice(0, max)

/**
 * Pure: project an {@link AuditInput} into a fully-formed {@link AuditEntry} at the
 * given sequence + timestamp. Bounds every field so a forged/oversized payload can't
 * grow the log unboundedly; optional fields are OMITTED (not set to undefined) when
 * absent so the JSONL stays compact.
 */
export function shapeAuditEntry(input: AuditInput, seq: number, ts: number): AuditEntry {
  const entry: AuditEntry = {
    seq,
    ts,
    type: cap(input.type, MAX_SHORT),
    targetId: cap(input.targetId, MAX_SHORT),
    prompt: cap(input.prompt, MAX_LONG),
    nonce: cap(input.nonce, MAX_SHORT),
    status: input.status === undefined ? 'dispatched' : cap(input.status, MAX_SHORT)
  }
  if (input.outputs !== undefined) entry.outputs = cap(input.outputs, MAX_LONG)
  if (input.detail !== undefined) entry.detail = cap(input.detail, MAX_LONG)
  return entry
}

/** Parse a JSONL blob into entries, tolerating blank/corrupt lines (skip, never throw). */
function parseEntries(raw: string): AuditEntry[] {
  const out: AuditEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as AuditEntry
      if (parsed && typeof parsed.seq === 'number') out.push(parsed)
    } catch {
      // a torn/partial trailing write or hand-edited line — skip it, keep the rest.
    }
  }
  return out
}

/**
 * Build an audit log bound to a directory. The monotonic sequence is seeded once from
 * the file's max existing seq (so it survives a restart / a fresh instance over the
 * same dir) then incremented in-memory. `now` is injectable for tests.
 */
export function createAuditLog(opts: {
  dir: string
  now?: () => number
  fileName?: string
}): AuditLog {
  const now = opts.now ?? Date.now
  const path = join(opts.dir, opts.fileName ?? AUDIT_FILE)
  let nextSeq: Promise<number> | null = null

  const readRaw = async (): Promise<string> => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return '' // absent log → empty
    }
  }

  const initSeq = (): Promise<number> => {
    if (!nextSeq) {
      nextSeq = readRaw().then((raw) => {
        const entries = parseEntries(raw)
        return entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1
      })
    }
    return nextSeq
  }

  return {
    async append(input) {
      // Reserve a sequence by CHAINING through the single tail promise: each caller awaits
      // the prior reservation, so two concurrent appends can't both read the same pending
      // seq (which would dup the seq + interleave writes). The tail resolves to the seq
      // the NEXT caller will use; this caller consumes the value it awaited.
      const reservation = initSeq()
      nextSeq = reservation.then((seq) => seq + 1)
      const seq = await reservation
      const entry = shapeAuditEntry(input, seq, now())
      await mkdir(opts.dir, { recursive: true })
      await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
      return entry
    },
    async read(readOpts) {
      const limit = readOpts?.limit ?? DEFAULT_READ_LIMIT
      const entries = parseEntries(await readRaw())
      return entries.slice(-limit).reverse()
    }
  }
}

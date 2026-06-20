import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises'
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
/** Hard cap for a single read request (DOS memory bound) — shared with the IPC surface. */
export const MAX_READ_LIMIT = 1000
const AUDIT_FILE = 'mcp-audit.jsonl'

/**
 * MCP-03: the active log rotates once it passes this size, capping disk to ~2× this (one prior
 * `.1` generation is kept; an older one is overwritten). Append stays append-only on the active
 * file — only the (rare) rotation renames it. 8 MiB ≈ tens of thousands of typical entries.
 */
export const MAX_BYTES = 8 * 1024 * 1024
/**
 * MCP-03: `read` tail-reads at most this many bytes from the active file (and, if needed to satisfy
 * the limit, from the rotated `.1`) instead of slurping the whole log into memory. This bounds the
 * read cost regardless of log size — older-than-the-tail entries are simply not returned (the same
 * recency bias the JSONL audit viewer already shows; the full forensic record is still on disk).
 */
export const READ_TAIL_BYTES = 1 * 1024 * 1024
/** The single retained prior generation after a rotation. */
const ROTATED_SUFFIX = '.1'

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
 * MCP-03: read at most the last `maxBytes` of a file (the END holds the newest entries) without
 * slurping the whole thing. A leading partial line (when the window cuts mid-entry) is harmless —
 * parseEntries skips an unparseable line. Absent/unreadable file → '' (never throws). The greatest
 * `seq` always lives in this tail, so seeding the monotonic counter from it stays correct.
 */
async function readTail(file: string, maxBytes: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    if (size === 0) return ''
    const start = size > maxBytes ? size - maxBytes : 0
    const len = size - start
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return '' // absent / unreadable
  } finally {
    await fh?.close()
  }
}

/** Greatest `seq` across one or more JSONL tails (0 when none). */
function maxSeqOf(...tails: string[]): number {
  let max = 0
  for (const raw of tails) for (const e of parseEntries(raw)) if (e.seq > max) max = e.seq
  return max
}

/**
 * Build an audit log bound to a directory. The monotonic sequence is seeded once from the max
 * existing seq across the active log + its rotated `.1` generation (so it survives a restart / a
 * fresh instance / a rotation) then incremented in-memory. `now` is injectable for tests; `maxBytes`
 * overrides the rotation threshold (tests force a tiny cap). The serialized state also tracks the
 * active file's byte size so a rotation can fire WITHOUT a per-append stat.
 */
export function createAuditLog(opts: {
  dir: string
  now?: () => number
  fileName?: string
  /** MCP-03: rotation threshold for the active file (default {@link MAX_BYTES}). */
  maxBytes?: number
}): AuditLog {
  const now = opts.now ?? Date.now
  const path = join(opts.dir, opts.fileName ?? AUDIT_FILE)
  const rotatedPath = path + ROTATED_SUFFIX
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_BYTES
  // Combined, serialized state: the NEXT seq to assign + the active file's current byte size. One
  // promise chain serializes the whole append (seq reservation + write + size bookkeeping + rotate).
  let state: Promise<{ seq: number; bytes: number }> | null = null

  const initState = (): Promise<{ seq: number; bytes: number }> => {
    if (!state) {
      state = (async () => {
        const [cur, rot] = await Promise.all([
          readTail(path, READ_TAIL_BYTES),
          readTail(rotatedPath, READ_TAIL_BYTES)
        ])
        let bytes = 0
        try {
          bytes = (await stat(path)).size
        } catch {
          bytes = 0 // absent active log
        }
        return { seq: maxSeqOf(cur, rot) + 1, bytes }
      })()
    }
    return state
  }

  return {
    async append(input) {
      // Serialize the ENTIRE append (seq reservation + the actual write + rotation) through a single
      // tail promise (BUG-024). Each caller chains its build+write onto the prior tail and resolves
      // it to the NEXT {seq,bytes} only AFTER its own appendFile completes:
      //   • physical file order matches seq order — a later caller's write can't begin until the
      //     earlier write has finished (serializing only the seq ARITHMETIC let two appendFile calls
      //     be in-flight at once → out-of-order JSONL lines).
      //   • a failed write does NOT burn its seq OR phantom-grow the size — the tail is reset to the
      //     SAME {seq,bytes} so the next append retries that number, no gap, no false rotation.
      // The caller still gets the entry it wrote (or the write error) via a captured deferred.
      let settle!: (entry: AuditEntry) => void
      let fail!: (err: unknown) => void
      const result = new Promise<AuditEntry>((res, rej) => {
        settle = res
        fail = rej
      })
      const tail = initState()
      state = tail.then(async ({ seq, bytes }) => {
        try {
          const entry = shapeAuditEntry(input, seq, now())
          const line = JSON.stringify(entry) + '\n'
          await mkdir(opts.dir, { recursive: true })
          await appendFile(path, line, 'utf8')
          let nextBytes = bytes + Buffer.byteLength(line, 'utf8')
          // MCP-03: rotate once the active file passes the cap. rename atomically replaces any prior
          // `.1` (Node uses MOVEFILE_REPLACE_EXISTING on Windows) and is append-safe — the active
          // file simply starts fresh. Best-effort: a rename failure (a reader holding the handle)
          // just defers rotation to the next append rather than aborting the (already durable) write.
          if (nextBytes > maxBytes) {
            try {
              await rename(path, rotatedPath)
              nextBytes = 0
            } catch {
              /* keep the current size; retry the rotation on the next append */
            }
          }
          // settle AFTER any rotation so `await append()` resolves only once the entry is durable
          // AND the rotation (if any) has completed — the log state is fully consistent on return.
          settle(entry)
          return { seq: seq + 1, bytes: nextBytes } // advance ONLY after a durable write
        } catch (err) {
          fail(err)
          return { seq, bytes } // write failed → keep seq + bytes (no gap, no phantom growth)
        }
      })
      return result
    },
    async read(readOpts) {
      // 🔒 Clamp limit to a positive, finite integer so callers cannot accidentally (or
      // intentionally) trigger slice(-0) === slice(0) → full log return (BUG-043).
      // - 0 / negative / NaN / non-integer → default
      // - values above MAX_READ_LIMIT are capped (DOS memory bound)
      const raw = readOpts?.limit
      const limit =
        typeof raw === 'number' && Number.isInteger(raw) && raw > 0
          ? Math.min(raw, MAX_READ_LIMIT)
          : DEFAULT_READ_LIMIT
      // MCP-03: tail-read the active file; only stitch in the rotated generation when the active
      // tail can't satisfy the limit (e.g. right after a rotation). parseEntries tolerates a torn
      // leading line in either tail. Rotated entries are strictly older → prepend, then take newest.
      let entries = parseEntries(await readTail(path, READ_TAIL_BYTES))
      if (entries.length < limit) {
        const rot = await readTail(rotatedPath, READ_TAIL_BYTES)
        if (rot) entries = parseEntries(rot).concat(entries)
      }
      return entries.slice(-limit).reverse()
    }
  }
}

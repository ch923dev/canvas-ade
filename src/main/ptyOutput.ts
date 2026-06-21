/**
 * Pure helpers for exposing a board's PTY scrollback to the MCP layer (T1.4 🔒).
 *
 * The live PTY ring (`pty.ts`) stores RAW output — ANSI escape codes, ConPTY
 * soft-wraps, partial lines. We never hand that to an agent: ANSI control
 * sequences are an injection surface for whatever renders the agent's view, and an
 * unbounded dump violates the capped-read rule. So this module:
 *   1. strips ANSI to plain text, then
 *   2. serves it one tail-anchored, size-capped page at a time.
 * Pure (no electron/node-pty) so it is unit-tested directly; `pty.ts` reads the ring
 * and delegates here.
 */

/**
 * Hard cap on chars returned by one page. MUST equal the package's `MAX_OUTPUT_PAGE`
 * (`@expanse-ade/mcp` constants) so the tail-anchored cursor math lines up
 * across the two repos. Unit = UTF-16 code units (JS `String.length`).
 */
export const MAX_OUTPUT_PAGE = 25_000

/**
 * Matches the terminal escape sequences we strip:
 *  - CSI (7-bit):  ESC [ ... final byte          (SGR colors, cursor moves, erases)
 *  - OSC (7-bit):  ESC ] ... (BEL | ESC \)       (window title etc.)
 *  - DCS (7-bit):  ESC P ... (ESC \)             (sixel, tmux passthrough, XTGETTCAP)
 *  - 2-byte / charset / single-shift: ESC followed by one byte in 0x20-0x5F
 *  - CSI (8-bit):  0x9B ... final byte           (C1 equivalent of ESC [)
 *  - OSC (8-bit):  0x9D ... (BEL | 0x9C)         (C1 equivalent of ESC ])
 *  - DCS (8-bit):  0x90 ... (ESC \ | 0x9C)       (C1 equivalent of ESC P)
 * 8-bit C1 forms (0x80-0x9F) are emitted on POSIX; ConPTY re-renders them as
 * 7-bit on Windows, so the C1 branches are a POSIX-only practical concern.
 * Printable text, newlines and tabs are left intact.
 */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bP[^\x1b]*(?:\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b[ -/]+[@-~]|\x9b[0-9;?]*[ -/]*[@-~]|\x9d[^\x07\x9c\x1b]*(?:\x07|\x9c|\x1b\\)|\x90[^\x9c\x1b]*(?:\x9c|\x1b\\)/g

/** Strip ANSI/VT escape sequences, leaving plain text (newlines/tabs preserved). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, '')
}

/**
 * PERF-06: a chunk-deque output ring for the live PTY buffer. The `onData` listener
 * fires once per output chunk; the old ring did `prev + chunk` then `.slice()` on every
 * call once saturated — an O(cap) (256 KB) string copy PER chunk for a heavy-output
 * agent. This holds the chunks in a deque with a running `total`, dropping/trimming only
 * the OLDEST data on overflow (one bounded slice of the head chunk), so a steady stream
 * is amortised O(chunk) per push rather than O(cap). The join is deferred to `readRing`
 * (adopt-replay / scrollback page reads), which also collapses the deque to a single
 * chunk so repeated reads stay O(1). Pure — unit-tested directly.
 */
export interface OutputRing {
  /** Output chunks in arrival order; their concatenation is the buffered tail. */
  chunks: string[]
  /** Sum of chunk lengths (UTF-16 code units), kept in sync so push never scans. */
  total: number
  /** Max retained chars; older data is dropped beyond this. */
  cap: number
}

/** A fresh empty ring bounded at `cap` chars. */
export function createRing(cap: number): OutputRing {
  return { chunks: [], total: 0, cap }
}

/**
 * Append `chunk`, evicting the oldest data so `total` never exceeds `cap`. Drops whole
 * head chunks that are fully redundant (keeps the deque length bounded too), then trims
 * any residual overflow off the new head with a single bounded slice. No-op on `''`.
 */
export function pushRing(ring: OutputRing, chunk: string): void {
  if (!chunk) return
  ring.chunks.push(chunk)
  ring.total += chunk.length
  // Drop whole oldest chunks while the buffer would STILL hold ≥ cap without them.
  while (ring.chunks.length > 1 && ring.total - ring.chunks[0].length >= ring.cap) {
    ring.total -= ring.chunks[0].length
    ring.chunks.shift()
  }
  // Trim the (now oldest) chunk for any residual overflow — one bounded slice.
  if (ring.total > ring.cap) {
    const over = ring.total - ring.cap
    ring.chunks[0] = ring.chunks[0].slice(over)
    ring.total -= over
  }
}

/**
 * The buffered tail as one string. Collapses the deque to a single chunk so a later
 * read (or the next push's head math) stays cheap — readers expect a plain string.
 */
export function readRing(ring: OutputRing): string {
  if (ring.chunks.length === 0) return ''
  if (ring.chunks.length > 1) {
    const joined = ring.chunks.join('')
    ring.chunks = [joined]
    ring.total = joined.length
  }
  return ring.chunks[0]
}

/** One capped, tail-anchored page of cleaned scrollback. */
export interface OutputPage {
  /** Plain-text slice for this page, in chronological order. */
  text: string
  /** Total chars available after stripping (the full clean length). */
  total: number
  /** Chars in this page (`text.length`; always ≤ `MAX_OUTPUT_PAGE`). */
  returned: number
  /** Tail-anchored cursor for the NEXT, OLDER page; absent at the oldest char. */
  nextCursor?: number
  /** True at the oldest page when the host ring had discarded older output. */
  droppedOlder: boolean
}

export interface PageOpts {
  /** Chars-from-end already consumed (from a prior page's `nextCursor`). Default 0. */
  cursor?: number
  /** Page size; clamped to `MAX_OUTPUT_PAGE`. Default `MAX_OUTPUT_PAGE`. */
  limit?: number
  /** Whether the source ring was saturated (older raw bytes already dropped). */
  truncatedHead?: boolean
}

/**
 * Slice `clean` into a tail-anchored page. Cursor 0 returns the NEWEST `limit`
 * chars; the returned `nextCursor` walks backward into older content. `droppedOlder`
 * is true only once the oldest available char has been returned AND the source ring
 * had already discarded older bytes (`truncatedHead`) — an honest "there was more,
 * it's gone" signal, never a silent blind-truncate.
 */
export function pageOutput(clean: string, opts: PageOpts): OutputPage {
  const total = clean.length
  const cap = Math.min(Math.max(0, opts.limit ?? MAX_OUTPUT_PAGE), MAX_OUTPUT_PAGE)
  const cursor = Math.max(0, opts.cursor ?? 0)
  const end = Math.max(0, total - cursor)
  const start = Math.max(0, end - cap)
  const text = clean.slice(start, end)
  const moreOlder = start > 0
  return {
    text,
    total,
    returned: text.length,
    nextCursor: moreOlder ? cursor + text.length : undefined,
    droppedOlder: !moreOlder && opts.truncatedHead === true
  }
}

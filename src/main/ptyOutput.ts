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
 * (`@ch923dev/canvas-ade-mcp` constants) so the tail-anchored cursor math lines up
 * across the two repos. Unit = UTF-16 code units (JS `String.length`).
 */
export const MAX_OUTPUT_PAGE = 25_000

/**
 * Matches the terminal escape sequences we strip:
 *  - CSI:  ESC [ … final byte           (SGR colors, cursor moves, erases)
 *  - OSC:  ESC ] … (BEL | ESC \)        (window title etc.)
 *  - 2-byte / charset / single-shift:   ESC followed by one byte in 0x20–0x5F
 * Printable text, newlines and tabs are left intact.
 */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b[ -/]+[@-~]/g

/** Strip ANSI/VT escape sequences, leaving plain text (newlines/tabs preserved). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, '')
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

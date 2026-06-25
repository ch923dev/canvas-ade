/**
 * Coalesce + liveness-gate PTY → xterm writes (terminal-crisp umbrella, Lane A;
 * docs/research/2026-06-25-terminal-dom-renderer › Lane A).
 *
 * xterm's DOM renderer draws ALL incoming data regardless of whether its board is on-screen
 * (xterm #880), so a below-LOD / off-screen terminal still pays the full parse + DOM-mutation
 * cost on every PTY chunk — the renderer-agnostic write-path cost P2 isolated as the only real
 * load at heavy concurrent streaming. This coalescer is the durable fix:
 *
 *   - BATCH a burst of small chunks into ONE term.write per animation frame (fewer parser
 *     entries / DOM reflows than one write per PTY chunk).
 *   - HOLD the buffer entirely while the board is hidden (below-LOD / off-screen). The PTY
 *     session NEVER pauses — bytes keep arriving and accumulating — but nothing is rendered, so
 *     a hidden terminal costs ~0 on the main thread (the terminal analogue of OSR's "frozen last
 *     frame": leave the DOM as-is, stop applying writes). On becoming visible the held bytes are
 *     flushed in order, so the revealed terminal catches up to the live session losslessly.
 *   - BOUND the held buffer to a scrollback-derived byte budget so a hidden firehose can't grow
 *     unbounded: the OLDEST held chunks are dropped (whole-chunk, never sliced mid-escape — the
 *     parser resynchronises on the next SGR/newline), keeping the most-recent tail. This matches
 *     what xterm's own scrollback would have evicted once the data rendered, so "lossless on
 *     reveal" means lossless up to the configured scrollback — exactly a visible terminal's
 *     guarantee.
 *
 * Pure of React / DOM / xterm: the term.write sink, the visibility source, the frame scheduler,
 * and the cap are all injected, so the hold / flush / trim policy is unit-testable in isolation
 * (no rAF, no xterm). Mirrors the OSR liveness split (pure decision core + an effectful hook).
 */

/** Injected collaborators — keep the coalescer pure (no direct rAF / xterm / store access). */
export interface WriteCoalescerDeps {
  /** Sink for a coalesced chunk — xterm's `term.write`. */
  write: (chunk: string) => void
  /** Current visibility: false while below-LOD / off-screen (hold), true to flush. */
  isLive: () => boolean
  /** Schedule `flush` for the next frame (requestAnimationFrame); returns a cancel handle (> 0). */
  schedule: (flush: () => void) => number
  /** Cancel a scheduled flush (cancelAnimationFrame). */
  cancel: (handle: number) => void
  /**
   * Max HELD characters before the oldest chunks are dropped. A thunk (not a constant) so a live
   * scrollback edit is reflected without re-creating the coalescer — read at each enqueue.
   */
  holdCap: () => number
}

export interface TerminalWriteCoalescer {
  /** Enqueue a PTY chunk — coalesced into the next-frame flush when live; held when hidden. */
  enqueue: (chunk: string) => void
  /** Signal the board became visible — flush the held buffer (next frame). No-op if nothing held. */
  onVisible: () => void
  /** Current held character count (the e2e held-bytes probe; proves the PTY produced while gated). */
  held: () => number
  /** Drop the buffer + cancel any scheduled flush. Used on restart (reuse the term) and teardown. */
  clear: () => void
}

export function createTerminalWriteCoalescer(deps: WriteCoalescerDeps): TerminalWriteCoalescer {
  const { write, isLive, schedule, cancel, holdCap } = deps
  // Held chunks (FIFO) + their running total length, so trimming the oldest is O(dropped).
  let chunks: string[] = []
  let len = 0
  // 0 = no flush scheduled (rAF handles are > 0). A single in-flight flush at a time.
  let handle = 0

  const flush = (): void => {
    handle = 0
    if (chunks.length === 0) return
    // Hidden: keep holding and do NOT reschedule — enqueue stops scheduling while hidden, so a
    // hidden firehose can't busy-loop rAF. onVisible() re-arms the flush when the board returns.
    if (!isLive()) return
    const out = chunks.join('')
    chunks = []
    len = 0
    write(out)
  }

  const ensureScheduled = (): void => {
    if (handle === 0) handle = schedule(flush)
  }

  /** Bound the held buffer to the cap by dropping the oldest WHOLE chunks (escape-sequence
   *  boundary safety — never slice). Always keep the latest chunk so a single jumbo chunk still
   *  renders. Runs on every enqueue: when live the buffer flushes each frame and stays far under
   *  the cap (no-op); it only bites while hidden — or while live-but-rAF-stalled (a minimised
   *  window), the one case a live buffer could otherwise grow unbounded. */
  const trim = (): void => {
    const cap = holdCap()
    while (len > cap && chunks.length > 1) {
      len -= chunks[0].length
      chunks.shift()
    }
  }

  return {
    enqueue(chunk) {
      if (chunk.length === 0) return
      chunks.push(chunk)
      len += chunk.length
      trim()
      if (isLive()) ensureScheduled()
    },
    onVisible() {
      if (chunks.length > 0) ensureScheduled()
    },
    held() {
      return len
    },
    clear() {
      if (handle !== 0) cancel(handle)
      handle = 0
      chunks = []
      len = 0
    }
  }
}

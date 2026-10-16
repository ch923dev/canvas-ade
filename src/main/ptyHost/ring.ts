/**
 * The daemon's bounded output ring — a chunk deque trimmed from the head (the pty.ts
 * OutputRing shape, kept dependency-free here so daemonMain.ts — which must never import
 * electron-adjacent modules — and the unit suite share ONE implementation).
 */
export interface DaemonRing {
  chunks: string[]
  len: number
  /**
   * Cumulative chars EVER pushed — monotonic, never decremented on eviction. The wrap predicate
   * ({@link daemonRingWrapped}) reads this, NOT `len`: see there. Required (not optional) so every
   * construction site must initialize it — use {@link createDaemonRing}.
   */
  written: number
}

/** A fresh empty ring (the one construction path — daemonMain + the suites). */
export function createDaemonRing(): DaemonRing {
  return { chunks: [], len: 0, written: 0 }
}

export function pushDaemonRing(r: DaemonRing, data: string, cap: number): void {
  r.chunks.push(data)
  r.len += data.length
  r.written += data.length
  while (r.len > cap && r.chunks.length > 1) {
    r.len -= r.chunks[0].length
    r.chunks.shift()
  }
  if (r.len > cap) {
    const only = r.chunks[0]
    r.chunks[0] = only.slice(only.length - cap)
    r.len = cap
  }
}

/**
 * Whether the ring has WRAPPED — `pushDaemonRing` has evicted/trimmed at least once, so the head
 * may be a torn line (mid-escape-sequence). `written > cap` is EXACTLY "something was evicted":
 * eviction runs only while `len > cap`, and `len` can only exceed `cap` once `written` does — at
 * the first push that takes `written` past `cap` nothing has been evicted yet, so `len === written`
 * and the trim fires. The old `len >= cap` test was wrong in BOTH directions:
 *   · false positive — a ring landing EXACTLY on `cap` with nothing evicted read as wrapped, so the
 *     replay dropped its intact first line on reattach (silent data loss);
 *   · false negative — this ring evicts WHOLE head chunks, which can leave `len` well BELOW `cap`
 *     with a head that starts at an arbitrary PTY read boundary; that read as unwrapped and
 *     replayed the torn head verbatim into xterm.
 * Mirrors the in-proc ring's `ringWrapped` (`ptyOutput.ts`, PR #369) — `ringParity.test.ts` holds
 * the two to the same verdict.
 */
export function daemonRingWrapped(r: DaemonRing, cap: number): boolean {
  return r.written > cap
}

/**
 * Replay = ring joined, head-trimmed to the first line boundary when the ring has wrapped
 * (DESIGN.md D3 / spike lesson: a byte-capped ring can open mid-escape-sequence; starting at
 * a fresh line keeps xterm clean). A single line longer than the ring replays as-is — losing
 * it entirely would be worse. Verbatim while unwrapped: nothing was dropped, the head is intact.
 */
export function daemonRingReplay(r: DaemonRing, cap: number): string {
  const joined = r.chunks.join('')
  if (!daemonRingWrapped(r, cap)) return joined
  const nl = joined.indexOf('\n')
  return nl >= 0 && nl < joined.length - 1 ? joined.slice(nl + 1) : joined
}
